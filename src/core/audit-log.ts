// Audit log — lightweight invocation tracking via SQLite
//
// Schema: one row per agent invocation with trace id, user, platform, cost, duration etc.
// Reuses the traceId from structured logging.

import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const AUDIT_DIR = join(homedir(), '.im-hub')
const AUDIT_DB = join(AUDIT_DIR, 'audit.db')

let db: Database.Database | null = null
let dbBroken = false

function getDb(): Database.Database | null {
  if (dbBroken) return null
  if (!db) {
    try {
      mkdirSync(AUDIT_DIR, { recursive: true })
      db = new Database(AUDIT_DB)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS invocations (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id  TEXT    NOT NULL,
          ts        TEXT    NOT NULL DEFAULT (datetime('now')),
          user_id   TEXT    NOT NULL DEFAULT '',
          platform  TEXT    NOT NULL DEFAULT '',
          agent     TEXT    NOT NULL,
          intent    TEXT    NOT NULL DEFAULT 'default',
          prompt_len INTEGER NOT NULL DEFAULT 0,
          response_len INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          cost      REAL    NOT NULL DEFAULT 0.0,
          success   INTEGER NOT NULL DEFAULT 1,
          error     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_inv_ts ON invocations(ts);
        CREATE INDEX IF NOT EXISTS idx_inv_agent ON invocations(agent);
        CREATE INDEX IF NOT EXISTS idx_inv_trace ON invocations(trace_id);
        CREATE INDEX IF NOT EXISTS idx_inv_user ON invocations(user_id);
        CREATE INDEX IF NOT EXISTS idx_inv_platform ON invocations(platform);
        CREATE INDEX IF NOT EXISTS idx_inv_intent ON invocations(intent);
      `)
    } catch (err) {
      // Native module unavailable (bun runtime) or disk error — skip auditing,
      // never fail the request pipeline.
      dbBroken = true
      db = null
      const msg = err instanceof Error ? err.message : String(err)
      if (process.env.LOG_LEVEL !== 'silent') {
        console.warn(`[audit-log] disabled: ${msg}`)
      }
      return null
    }
  }
  return db
}

export interface AuditRecord {
  traceId: string
  userId: string
  platform: string
  agent: string
  intent: string
  promptLen: number
  responseLen: number
  durationMs: number
  cost: number
  success: boolean
  error?: string
}

export function logInvocation(rec: AuditRecord): void {
  const d = getDb()
  if (!d) return
  try {
    const stmt = d.prepare(`
      INSERT INTO invocations (trace_id, user_id, platform, agent, intent, prompt_len, response_len, duration_ms, cost, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(rec.traceId, rec.userId, rec.platform, rec.agent, rec.intent,
      rec.promptLen, rec.responseLen, rec.durationMs, rec.cost,
      rec.success ? 1 : 0, rec.error || null)
  } catch {
    // Best-effort logging; never fail the request because of audit IO
  }
}

export interface QueryOpts {
  limit?: number
  agent?: string
  platform?: string
  userId?: string
  intent?: string
  days?: number
}

export interface InvocationRow {
  id: number
  trace_id: string
  ts: string
  user_id: string
  platform: string
  agent: string
  intent: string
  prompt_len: number
  response_len: number
  duration_ms: number
  cost: number
  success: number
  error: string | null
}

export function queryInvocations(opts: QueryOpts = {}): InvocationRow[] {
  const d = getDb()
  if (!d) return []
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.platform) { conditions.push('platform = ?'); params.push(opts.platform) }
  if (opts.userId) { conditions.push('user_id = ?'); params.push(opts.userId) }
  if (opts.intent) { conditions.push('intent = ?'); params.push(opts.intent) }
  if (opts.days && Number.isFinite(opts.days) && opts.days > 0) {
    conditions.push("ts >= datetime('now', ?)")
    params.push(`-${Math.floor(opts.days)} days`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rawLimit = opts.limit
  const limit = Number.isFinite(rawLimit) && rawLimit! > 0 ? Math.min(Math.floor(rawLimit!), 1000) : 20

  try {
    return d.prepare(`SELECT * FROM invocations ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as InvocationRow[]
  } catch {
    return []
  }
}

export function getStats(): { total: number; byAgent: Record<string, number>; totalCost: number } {
  const d = getDb()
  if (!d) return { total: 0, byAgent: {}, totalCost: 0 }
  try {
    const total = (d.prepare('SELECT COUNT(*) as n FROM invocations').get() as { n: number }).n
    const rows = d.prepare('SELECT agent, COUNT(*) as n, SUM(cost) as total_cost FROM invocations GROUP BY agent').all() as Array<{ agent: string; n: number; total_cost: number | null }>
    const byAgent: Record<string, number> = {}
    let totalCost = 0
    for (const r of rows) {
      byAgent[r.agent] = r.n
      totalCost += r.total_cost || 0
    }
    return { total, byAgent, totalCost }
  } catch {
    return { total: 0, byAgent: {}, totalCost: 0 }
  }
}
