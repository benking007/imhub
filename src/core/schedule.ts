// Scheduler — persistent cron-driven Job creation.
//
// Schedules live in the same SQLite DB as Jobs (extra table). A 30s tick
// scans for due rows, creates a Job for each, and bumps `next_run`. When
// SQLite is unavailable (bun runtime / disk error) the scheduler exposes
// the same API but persists nothing — exact same fail-soft pattern as
// audit-log + job-board.

import type Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import type { Logger } from 'pino'
import { logger as rootLogger } from './logger.js'
import { parseCron, nextOccurrence } from './cron.js'
import { createJob, runJob } from './job-board.js'
import { registry } from './registry.js'
import { AgentBase } from './agent-base.js'
import { createSqliteHelper } from './sqlite-helper.js'

const SCHED_DB = join(homedir(), '.im-hub', 'schedules.db')
const TICK_INTERVAL_MS = 30 * 1000

const log = rootLogger.child({ component: 'schedule' })

let tickTimer: ReturnType<typeof setInterval> | null = null

export interface Schedule {
  id: number
  name: string
  agent: string
  prompt: string
  cron: string
  enabled: number  // SQLite stores as 0/1
  next_run: string  // ISO
  last_run: string | null
  notify_url: string | null
  created_at: string
}

const helper = createSqliteHelper({
  file: SCHED_DB,
  component: 'schedule',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      agent       TEXT    NOT NULL,
      prompt      TEXT    NOT NULL,
      cron        TEXT    NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      next_run    TEXT    NOT NULL,
      last_run    TEXT,
      notify_url  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_next ON schedules(next_run, enabled);
  `,
})

function getDb(): Database.Database | null {
  return helper.get()
}

export interface CreateScheduleInput {
  name: string
  agent: string
  prompt: string
  cron: string
  notifyUrl?: string
  enabled?: boolean
}

export function createSchedule(input: CreateScheduleInput): number {
  const d = getDb()
  if (!d) throw new Error('Scheduler unavailable (SQLite not initialized)')
  const spec = parseCron(input.cron)  // throws on bad expr
  const next = nextOccurrence(spec, new Date())
  if (!next) throw new Error('Cron expression has no future occurrence')
  const info = d.prepare(
    'INSERT INTO schedules (name, agent, prompt, cron, enabled, next_run, notify_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(input.name, input.agent, input.prompt, input.cron,
    input.enabled === false ? 0 : 1, next.toISOString(), input.notifyUrl || null)
  return Number(info.lastInsertRowid)
}

export function listSchedules(limit = 50): Schedule[] {
  const d = getDb()
  if (!d) return []
  return d.prepare('SELECT * FROM schedules ORDER BY id DESC LIMIT ?').all(limit) as Schedule[]
}

export function getSchedule(id: number): Schedule | null {
  const d = getDb()
  if (!d) return null
  const row = d.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Schedule | undefined
  return row || null
}

export function deleteSchedule(id: number): boolean {
  const d = getDb()
  if (!d) return false
  return d.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
}

export function setEnabled(id: number, enabled: boolean): boolean {
  const d = getDb()
  if (!d) return false
  return d.prepare('UPDATE schedules SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id).changes > 0
}

/** Find schedules whose next_run is at or before `now` and are enabled. */
function dueSchedules(d: Database.Database, now: Date): Schedule[] {
  return d.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run <= ?"
  ).all(now.toISOString()) as Schedule[]
}

/**
 * Execute a single scheduled run: create a Job, kick it off through Job
 * Board (which honors the concurrency cap), bump next_run.
 */
async function fireSchedule(s: Schedule, logger: Logger): Promise<void> {
  const d = getDb()
  if (!d) return

  const agent = registry.findAgent(s.agent)
  if (!agent) {
    logger.warn({ scheduleId: s.id, agent: s.agent }, 'Schedule agent not registered, skipping')
    return
  }

  const jobId = createJob(s.agent, s.prompt)
  logger.info({ scheduleId: s.id, jobId, name: s.name }, 'Schedule fired')

  // Compute next_run BEFORE running so even a long-running job doesn't
  // block the next tick.
  try {
    const nextSpec = parseCron(s.cron)
    const next = nextOccurrence(nextSpec, new Date())
    if (next) {
      d.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?')
        .run(new Date().toISOString(), next.toISOString(), s.id)
    }
  } catch {
    // Bad cron at this point would only happen if it was edited externally.
    // Disable rather than re-fire forever.
    d.prepare('UPDATE schedules SET enabled = 0 WHERE id = ?').run(s.id)
  }

  // Run via Job Board so the result is persisted + bounded concurrency.
  void runJob(jobId, async function* (job, jobLogger, signal) {
    if (agent instanceof AgentBase) {
      const text = await agent.spawnAndCollect(job.prompt, signal)
      if (text) yield text
    } else {
      for await (const chunk of agent.sendPrompt(`schedule-${s.id}-${jobId}`, job.prompt, [])) {
        if (signal.aborted) break
        yield chunk
      }
    }
  }, logger).then(async () => {
    if (s.notify_url) {
      try {
        const job = (await import('./job-board.js')).getJob(jobId)
        if (job) {
          await fetch(s.notify_url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scheduleId: s.id,
              jobId,
              status: job.status,
              result: job.result,
              error: job.error,
            }),
          })
        }
      } catch (err) {
        logger.warn({ scheduleId: s.id, err: err instanceof Error ? err.message : String(err) },
          'Schedule notify webhook failed')
      }
    }
  }).catch(() => { /* runJob already logged */ })
}

/** Run one tick — exposed for tests so they don't have to wait for setInterval. */
export async function tick(now: Date = new Date()): Promise<number> {
  const d = getDb()
  if (!d) return 0
  const due = dueSchedules(d, now)
  for (const s of due) {
    await fireSchedule(s, log).catch((err) => {
      log.error({ scheduleId: s.id, err: err instanceof Error ? err.message : String(err) },
        'fireSchedule threw')
    })
  }
  return due.length
}

/** Start the periodic ticker. Idempotent. */
export function startScheduler(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => { void tick() }, TICK_INTERVAL_MS)
  if (typeof tickTimer === 'object' && tickTimer && 'unref' in tickTimer) {
    (tickTimer as { unref: () => void }).unref()
  }
  log.info({ tickMs: TICK_INTERVAL_MS }, 'Scheduler started')
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
