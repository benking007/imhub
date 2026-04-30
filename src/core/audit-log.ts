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

function getDb(): Database.Database {
  if (!db) {
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
    `)
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
  const stmt = d.prepare(`
    INSERT INTO invocations (trace_id, user_id, platform, agent, intent, prompt_len, response_len, duration_ms, cost, success, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(rec.traceId, rec.userId, rec.platform, rec.agent, rec.intent,
    rec.promptLen, rec.responseLen, rec.durationMs, rec.cost,
    rec.success ? 1 : 0, rec.error || null)
}

export interface QueryOpts {
  limit?: number
  agent?: string
  platform?: string
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
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.platform) { conditions.push('platform = ?'); params.push(opts.platform) }
  if (opts.days) { conditions.push("ts >= datetime('now', ?)"); params.push(`-${opts.days} days`) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit || 20

  return d.prepare(`SELECT * FROM invocations ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as InvocationRow[]
}

export function getStats(): { total: number; byAgent: Record<string, number>; totalCost: number } {
  const d = getDb()
  const total = (d.prepare('SELECT COUNT(*) as n FROM invocations').get() as { n: number }).n
  const rows = d.prepare('SELECT agent, COUNT(*) as n, SUM(cost) as total_cost FROM invocations GROUP BY agent').all() as Array<{ agent: string; n: number; total_cost: number }>
  const byAgent: Record<string, number> = {}
  let totalCost = 0
  for (const r of rows) {
    byAgent[r.agent] = r.n
    totalCost += r.total_cost
  }
  return { total, byAgent, totalCost }
}
