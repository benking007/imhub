// Job Board — persistent async job queue backed by SQLite
//
// Jobs survive restarts. Each job executes an agent invocation and stores the result.
// Supports: create, list, get, cancel.

import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { Logger } from 'pino'
import { logger as rootLogger } from './logger.js'

const BOARD_DIR = join(homedir(), '.im-hub')
const BOARD_DB = join(BOARD_DIR, 'jobs.db')

/** Hard cap on concurrent runJob() invocations. Spawning more than this
 * would let a few /job run X requests OOM the host (each agent process
 * carries hundreds of MB). Override via env IM_HUB_MAX_CONCURRENT_JOBS. */
function resolveMaxConcurrent(): number {
  const raw = process.env.IM_HUB_MAX_CONCURRENT_JOBS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 3
}

let db: Database.Database | null = null
let dbBroken = false

// Running job controllers (for cancellation)
const runningControllers = new Map<number, AbortController>()

// Wait queue for jobs that arrived while at capacity. Each entry is the
// resolver of a Promise the caller is awaiting on.
const waitQueue: Array<() => void> = []
let activeJobs = 0

/**
 * Reset jobs that were 'running' when the previous im-hub process died.
 * Without this, those rows stay marked 'running' forever and every
 * /job list shows ghosts.
 */
function reapStaleRunning(d: Database.Database): void {
  try {
    const stmt = d.prepare(
      "UPDATE jobs SET status='failed', error='im-hub restarted while running', completed_at=datetime('now') WHERE status='running'"
    )
    const info = stmt.run()
    if (info.changes > 0) {
      rootLogger.warn({ event: 'job-board.reap', stale: info.changes },
        `Marked ${info.changes} stale running job(s) as failed`)
    }
  } catch {
    // best-effort; missing table is fine on first start
  }
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: number
  status: JobStatus
  agent: string
  prompt: string
  result: string | null
  error: string | null
  created_at: string
  completed_at: string | null
}

interface JobRunner {
  (job: Job, logger: Logger, signal: AbortSignal): AsyncGenerator<string>
}

function getDb(): Database.Database | null {
  if (dbBroken) return null
  if (!db) {
    try {
      mkdirSync(BOARD_DIR, { recursive: true })
      db = new Database(BOARD_DB)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent       TEXT    NOT NULL,
          prompt      TEXT    NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'pending',
          result      TEXT,
          error       TEXT,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
      `)
      // First-time / cold-start cleanup: any 'running' rows are leftover
      // from a prior process that didn't get to finalize.
      reapStaleRunning(db)
    } catch (err) {
      dbBroken = true
      db = null
      const msg = err instanceof Error ? err.message : String(err)
      if (process.env.LOG_LEVEL !== 'silent') {
        rootLogger.warn({ event: 'job-board.disabled', error: msg },
          `[job-board] disabled: ${msg}`)
      }
      return null
    }
  }
  return db
}

export function createJob(agent: string, prompt: string): number {
  const d = getDb()
  if (!d) throw new Error('Job board unavailable (SQLite not initialized)')
  const row = d.prepare('INSERT INTO jobs (agent, prompt, status) VALUES (?, ?, ?)')
    .run(agent, prompt, 'pending')
  return Number(row.lastInsertRowid)
}

export function getJob(id: number): Job | null {
  const d = getDb()
  if (!d) return null
  const row = d.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined
  return row || null
}

export function listJobs(limit = 20, status?: JobStatus): Job[] {
  const d = getDb()
  if (!d) return []
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 20
  if (status) {
    return d.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, safeLimit) as Job[]
  }
  return d.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(safeLimit) as Job[]
}

function updateJob(id: number, fields: Partial<Job>): void {
  const d = getDb()
  if (!d) return
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v) }
  }
  if (!sets.length) return
  d.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

/**
 * Acquire a job slot. Returns immediately when capacity available, otherwise
 * queues the caller and returns a promise that resolves when a slot frees.
 */
async function acquireSlot(): Promise<void> {
  const max = resolveMaxConcurrent()
  if (activeJobs < max) {
    activeJobs++
    return
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve))
  activeJobs++
}

function releaseSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1)
  const next = waitQueue.shift()
  if (next) next()
}

export async function runJob(
  id: number,
  runner: JobRunner,
  logger: Logger
): Promise<void> {
  const job = getJob(id)
  if (!job) return

  // Block here if the job board is at capacity. The job stays 'pending' in
  // SQLite while waiting — visible to /job list as queued.
  await acquireSlot()

  const controller = new AbortController()
  runningControllers.set(id, controller)

  updateJob(id, { status: 'running' })
  logger.info({ event: 'job.start', jobId: id, agent: job.agent, active: activeJobs })

  let fullText = ''
  try {
    for await (const chunk of runner(job, logger, controller.signal)) {
      if (controller.signal.aborted) break
      fullText += chunk
    }
    // Only update if not cancelled
    if (!controller.signal.aborted) {
      updateJob(id, { status: 'completed', result: fullText, completed_at: new Date().toISOString() })
      logger.info({ event: 'job.complete', jobId: id, resultLen: fullText.length })
    } else {
      updateJob(id, { status: 'cancelled', result: fullText || null, completed_at: new Date().toISOString() })
      logger.info({ event: 'job.cancelled', jobId: id })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    updateJob(id, { status: 'failed', error: msg, completed_at: new Date().toISOString() })
    logger.error({ event: 'job.failed', jobId: id, error: msg, stack })
  } finally {
    runningControllers.delete(id)
    releaseSlot()
  }
}

/** Test/diagnostic accessor: how many runJob invocations are currently in flight. */
export function _activeJobCount(): number { return activeJobs }
/** Test/diagnostic accessor: the wait queue depth. */
export function _waitQueueDepth(): number { return waitQueue.length }
/** Test-only: directly exercise the concurrency gate without SQLite. */
export const _testSlot = { acquire: acquireSlot, release: releaseSlot }

export function cancelJob(id: number): boolean {
  const job = getJob(id)
  if (!job || (job.status !== 'pending' && job.status !== 'running')) return false
  const ctrl = runningControllers.get(id)
  if (ctrl) {
    ctrl.abort()
    runningControllers.delete(id)
  }
  updateJob(id, { status: 'cancelled', completed_at: new Date().toISOString() })
  return true
}

export function getJobStats(): { total: number; pending: number; running: number; completed: number; failed: number } {
  const empty = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 }
  const d = getDb()
  if (!d) return empty
  try {
    const row = d.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM jobs
    `).get() as Record<string, number>
    return {
      total: row.total || 0, pending: row.pending || 0, running: row.running || 0,
      completed: row.completed || 0, failed: row.failed || 0,
    }
  } catch {
    return empty
  }
}
