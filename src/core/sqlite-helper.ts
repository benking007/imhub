// Shared SQLite helper — fail-soft DB initialization with the same
// `getDb()` + `dbBroken` pattern previously copied across audit-log,
// job-board, and schedule. Centralizing it makes the bun-degraded
// behavior consistent and one-place-to-fix.

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Logger } from 'pino'

export interface SqliteHelper {
  /** Get the live Database, or null if init has failed. */
  get(): Database.Database | null
  /** Wrap a DB call with a try/catch that returns `fallback` on error. */
  safe<T>(fn: (d: Database.Database) => T, fallback: T): T
  /** Mark the DB broken (test hook). */
  _markBroken(reason: string): void
}

export interface CreateOptions {
  /** Absolute path to the .db file. The parent dir is created if missing. */
  file: string
  /** SQL DDL run once after open (`CREATE TABLE IF NOT EXISTS …`). */
  schema: string
  /** Optional one-time migration / cleanup callback (e.g. job-board's
   *  reapStaleRunning). Invoked exactly once per process, after schema. */
  init?: (d: Database.Database) => void
  /** Pino logger (or compatible). Used to surface init failures. */
  logger?: Logger
  /** Component tag for logger child binding. Default: derived from file basename. */
  component?: string
}

/**
 * Create an opener that lazily initializes the DB on first call. If the
 * native module can't be loaded (bun runtime, missing libstdc++) or any
 * step throws, the helper transitions to "broken" and every subsequent
 * `get()` returns null — letting callers fail soft without crashing the
 * pipeline.
 */
export function createSqliteHelper(opts: CreateOptions): SqliteHelper {
  let db: Database.Database | null = null
  let dbBroken = false
  const log = opts.logger?.child({ component: opts.component || 'sqlite' })

  return {
    get(): Database.Database | null {
      if (dbBroken) return null
      if (!db) {
        try {
          mkdirSync(dirname(opts.file), { recursive: true })
          db = new Database(opts.file)
          db.pragma('journal_mode = WAL')
          db.pragma('synchronous = NORMAL')
          db.exec(opts.schema)
          if (opts.init) opts.init(db)
        } catch (err) {
          dbBroken = true
          db = null
          const msg = err instanceof Error ? err.message : String(err)
          log?.warn({ event: 'sqlite.disabled', file: opts.file, error: msg },
            `${opts.component || 'sqlite'} disabled: ${msg}`)
          return null
        }
      }
      return db
    },

    safe<T>(fn: (d: Database.Database) => T, fallback: T): T {
      const d = this.get()
      if (!d) return fallback
      try {
        return fn(d)
      } catch (err) {
        log?.warn({ event: 'sqlite.query.failed', error: err instanceof Error ? err.message : String(err) },
          'SQLite query failed')
        return fallback
      }
    },

    _markBroken(reason: string): void {
      dbBroken = true
      db = null
      log?.warn({ event: 'sqlite.markbroken', reason }, `marked broken: ${reason}`)
    },
  }
}
