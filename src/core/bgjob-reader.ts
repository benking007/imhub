// bgjob-reader — read-only view into the bgjob directories used by Claude Code
// and opencode. Format documented in /root/.claude/CLAUDE.md and the wrapper at
// /root/.config/opencode/scripts/bgjob.
//
// Layout per root:
//   <root>/
//     index.json              { jobs: [{id, name, started_at}, ...] }
//     <id>/meta.json          { id, name, cmd[], status, pid, started_at, ended_at, exit_code, ... }
//     <id>/log.txt            merged stdout+stderr
//
// We read these files directly (no Python wrapper subprocess). The wrapper is
// the source of truth for writes; we are strictly the read side.
//
// Multiple roots are supported (claude / opencode are isolated by design).
// Configurable via env IMHUB_BGJOB_ROOTS — comma-separated absolute paths.

import { readFile, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, isAbsolute, resolve, basename } from 'path'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'bgjob-reader' })

export interface BgjobRoot {
  /** Stable identifier for the UI: 'claude', 'opencode', or basename of custom path. */
  id: string
  /** Filesystem path. */
  path: string
  /** Pretty label for display. */
  label: string
}

export interface BgjobSummary {
  id: string
  name: string
  status: string                   // running | completed | failed | killed | ...
  pid: number | null
  started_at: string | null
  ended_at: string | null
  exit_code: number | null
  restart_generation: number
  /** Source root id (e.g. 'claude' or 'opencode') — useful when caller mixes roots. */
  rootId: string
}

export interface BgjobDetail extends BgjobSummary {
  cmd: string[]
  workdir: string | null
  out_dir: string | null
  log_path: string | null
  resources: { cpu_time?: number; rss_kb?: number; state?: string } | null
  /** Tail of log.txt (last `tailLines` lines). */
  log_tail: string | null
}

const DEFAULT_ROOTS: BgjobRoot[] = [
  { id: 'claude',   path: join(homedir(), '.claude', 'bgjobs'),         label: 'Claude Code' },
  { id: 'opencode', path: join(homedir(), '.config', 'opencode', 'bgjobs'), label: 'opencode' },
]

/**
 * Resolve the configured roots. Reads env IMHUB_BGJOB_ROOTS — comma-separated
 * absolute paths, optionally with id prefix `id=path`. Falls back to the two
 * defaults so a fresh install just works.
 */
export function resolveRoots(): BgjobRoot[] {
  const raw = process.env.IMHUB_BGJOB_ROOTS
  if (!raw || !raw.trim()) return DEFAULT_ROOTS
  const out: BgjobRoot[] = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    let id: string, path: string
    if (eq > 0) {
      id = part.slice(0, eq).trim()
      path = part.slice(eq + 1).trim()
    } else {
      path = part
      id = basename(path) || path
    }
    if (!isAbsolute(path)) {
      log.warn({ part }, 'IMHUB_BGJOB_ROOTS entry must be absolute, ignoring')
      continue
    }
    out.push({ id, path: resolve(path), label: id })
  }
  return out.length ? out : DEFAULT_ROOTS
}

function safeJsonParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T } catch { return null }
}

interface IndexJson {
  jobs?: Array<{ id?: string; name?: string; started_at?: string }>
}

interface MetaJson {
  id?: string
  name?: string
  cmd?: string[]
  workdir?: string
  status?: string
  pid?: number | null
  started_at?: string | null
  ended_at?: string | null
  exit_code?: number | null
  log?: string
  out_dir?: string
  restart_generation?: number
  resources?: { cpu_time?: number; rss_kb?: number; state?: string }
}

/**
 * List all bgjobs under one root, newest first by started_at.
 *
 * If <root>/index.json exists we use that as the authoritative ID set;
 * otherwise we fall back to scanning subdirectories that look like job IDs.
 * Both paths read each job's meta.json for status — index.json itself does
 * not record status.
 */
export async function listJobsForRoot(root: BgjobRoot): Promise<BgjobSummary[]> {
  let jobIds: string[] = []
  try {
    const idxRaw = await readFile(join(root.path, 'index.json'), 'utf-8')
    const idx = safeJsonParse<IndexJson>(idxRaw)
    if (idx?.jobs?.length) jobIds = idx.jobs.map((j) => j.id || '').filter(Boolean)
  } catch {
    // Missing index.json — try directory scan as fallback. This also handles
    // the case where a wrapper hasn't been run yet but stale dirs exist.
    try {
      const entries = await readdir(root.path, { withFileTypes: true })
      jobIds = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (err) {
      log.debug({ root: root.id, err: (err as Error).message }, 'bgjob root not accessible')
      return []
    }
  }

  const out: BgjobSummary[] = []
  for (const id of jobIds) {
    const meta = await readMeta(root, id)
    if (!meta) continue
    out.push(metaToSummary(root, meta))
  }
  // newest first by started_at; fallback to id (lexical, contains timestamp prefix)
  out.sort((a, b) => {
    const ta = a.started_at || a.id
    const tb = b.started_at || b.id
    return tb.localeCompare(ta)
  })
  return out
}

async function readMeta(root: BgjobRoot, id: string): Promise<MetaJson | null> {
  // Defense in depth: ID is from a trusted file but we still reject path
  // separators so a malformed entry can't escape the root.
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return null
  try {
    const raw = await readFile(join(root.path, id, 'meta.json'), 'utf-8')
    return safeJsonParse<MetaJson>(raw)
  } catch {
    return null
  }
}

function metaToSummary(root: BgjobRoot, meta: MetaJson): BgjobSummary {
  return {
    id: meta.id || '',
    name: meta.name || '',
    status: meta.status || 'unknown',
    pid: typeof meta.pid === 'number' ? meta.pid : null,
    started_at: meta.started_at ?? null,
    ended_at: meta.ended_at ?? null,
    exit_code: typeof meta.exit_code === 'number' ? meta.exit_code : null,
    restart_generation: typeof meta.restart_generation === 'number' ? meta.restart_generation : 0,
    rootId: root.id,
  }
}

/**
 * Get full detail for one job, including a tail of its log file. Returns null
 * if the id isn't found in this root.
 */
export async function getJobDetail(
  root: BgjobRoot,
  id: string,
  tailLines = 200,
): Promise<BgjobDetail | null> {
  const meta = await readMeta(root, id)
  if (!meta) return null

  const summary = metaToSummary(root, meta)
  const logPath = meta.log || join(root.path, id, 'log.txt')
  const logTail = await readLogTail(logPath, tailLines)

  return {
    ...summary,
    cmd: Array.isArray(meta.cmd) ? meta.cmd : [],
    workdir: meta.workdir || null,
    out_dir: meta.out_dir || null,
    log_path: logPath,
    resources: meta.resources || null,
    log_tail: logTail,
  }
}

async function readLogTail(path: string, lines: number): Promise<string | null> {
  try {
    const st = await stat(path)
    if (!st.isFile()) return null
    // Cheap implementation: read whole file then slice. log.txt typically caps
    // at ~MB; for huge logs the wrapper rotates. If a job balloons the file
    // we still want responsiveness, so cap read at 2MB.
    const MAX_BYTES = 2 * 1024 * 1024
    if (st.size > MAX_BYTES) {
      const fd = await import('fs/promises').then((m) => m.open(path, 'r'))
      try {
        const buf = Buffer.alloc(MAX_BYTES)
        await fd.read(buf, 0, MAX_BYTES, st.size - MAX_BYTES)
        const text = buf.toString('utf-8')
        // Drop the first (likely partial) line so we don't show a fragment.
        const nl = text.indexOf('\n')
        const tail = nl >= 0 ? text.slice(nl + 1) : text
        return takeLastLines(tail, lines, true)
      } finally {
        await fd.close()
      }
    }
    const text = await readFile(path, 'utf-8')
    return takeLastLines(text, lines, false)
  } catch {
    return null
  }
}

function takeLastLines(text: string, n: number, truncatedHead: boolean): string {
  const all = text.split('\n')
  // Drop trailing empty line(s) for cleaner output
  while (all.length && all[all.length - 1] === '') all.pop()
  const slice = all.slice(-n).join('\n')
  return truncatedHead ? '…(truncated)\n' + slice : slice
}

/**
 * Convenience: list jobs across every configured root. Each item carries its
 * `rootId` so the UI can render or filter. Concurrency is per-root so a slow
 * filesystem on one root doesn't block another.
 */
export async function listAllJobs(): Promise<{ root: BgjobRoot; jobs: BgjobSummary[] }[]> {
  const roots = resolveRoots()
  const results = await Promise.all(roots.map(async (root) => ({
    root,
    jobs: await listJobsForRoot(root).catch((err) => {
      log.warn({ root: root.id, err: (err as Error).message }, 'bgjob list failed')
      return [] as BgjobSummary[]
    }),
  })))
  return results
}

/** Resolve one root by id. Returns null if not configured. */
export function findRoot(rootId: string): BgjobRoot | null {
  return resolveRoots().find((r) => r.id === rootId) ?? null
}
