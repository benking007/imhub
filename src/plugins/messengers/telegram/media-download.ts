// Telegram media download helper.
//
// Downloads photo / document attachments to ~/.im-hub/media/telegram/<chatId>/
// so the claude-code agent (multimodal) can Read them by path. Decoupled from
// the adapter class so it's testable in isolation.
//
// Lifetime: cleanupOldMedia() prunes files older than the configured TTL,
// invoked hourly + at startup by the adapter. We do not delete on a per-thread
// basis — same image may be referenced across turns within a 30-min imhub
// session.

import { spawn } from 'child_process'
import { mkdir, readdir, rm, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'telegram.media' })

/** Root for downloaded media. Always resolved absolute so the safety check
 *  `path.startsWith(MEDIA_ROOT)` is robust. Override via env for tests. */
export const MEDIA_ROOT: string = resolve(
  process.env.IMHUB_MEDIA_ROOT ?? join(homedir(), '.im-hub', 'media'),
)

/** Hard upper bound on a single download. Telegram photo max is ~10 MB and
 *  document max is 50 MB on the bot API; we cap at 20 MB so a runaway upload
 *  can't fill the disk. */
export const MAX_BYTES = 20 * 1024 * 1024

/** Default cleanup TTL — 7 days. Long enough that a multi-day conversation
 *  can re-reference an image, short enough that the directory doesn't grow
 *  without bound. Override via env for ops. */
export const DEFAULT_TTL_MS: number = (() => {
  const raw = process.env.IMHUB_MEDIA_TTL_MS
  if (!raw) return 7 * 24 * 60 * 60 * 1000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 60 * 60 * 1000
})()

export interface DownloadParams {
  /** TG file URL — must be on api.telegram.org. */
  url: string
  /** Destination folder under MEDIA_ROOT, typically `${platform}/${chatId}`. */
  subdir: string
  /** Filename (no path components). */
  filename: string
}

export interface DownloadResult {
  path: string
  bytes: number
}

/**
 * Download `url` and write it to `<MEDIA_ROOT>/<subdir>/<filename>`. Returns
 * the absolute path on success. Errors out (and writes nothing) on:
 *   - non-https or non-telegram host
 *   - HTTP non-2xx
 *   - body larger than MAX_BYTES
 *   - destination resolves outside MEDIA_ROOT (path-injection guard)
 *
 * Best-effort cleanup: if write fails partway through, the partial file is
 * removed so a half-saved image never reaches the agent.
 */
export async function downloadToMediaRoot(params: DownloadParams): Promise<DownloadResult> {
  // Path-injection guard: filename must not contain separators / .. so the
  // join + resolve stays inside MEDIA_ROOT/subdir. subdir itself is built by
  // the adapter from numeric chatId, so we trust the caller there but still
  // do the post-resolve check below.
  if (params.filename.includes('/') || params.filename.includes('\\') || params.filename.includes('..')) {
    throw new Error(`unsafe filename: ${params.filename}`)
  }
  const u = new URL(params.url)
  if (u.protocol !== 'https:' || u.hostname !== 'api.telegram.org') {
    throw new Error(`refusing to download from ${u.host}: only api.telegram.org allowed`)
  }

  const dir = resolve(MEDIA_ROOT, params.subdir)
  const path = resolve(dir, params.filename)
  if (!path.startsWith(MEDIA_ROOT + '/')) {
    throw new Error(`destination escapes MEDIA_ROOT: ${path}`)
  }

  await mkdir(dir, { recursive: true })

  // Implementation note: we shell out to curl rather than using Node's fetch.
  // Observed in production: undici's fetch hits intermittent ETIMEDOUT against
  // api.telegram.org from this VM (3 retries all fail in ~2s while curl from
  // the same shell succeeds in <1s). Root cause unclear (HTTP/2 vs 1.1
  // negotiation, DNS warm-up, or a VM-specific routing quirk). curl is a
  // boring, well-tested OS tool — pragmatic answer is to use it.
  //
  // Size cap is enforced via curl's --max-filesize plus a post-download stat
  // (the flag relies on Content-Length when the server provides it; the stat
  // covers the case where the server omits it).
  await runCurl(params.url, path)
  let bytes: number
  try {
    bytes = (await stat(path)).size
  } catch (err) {
    throw new Error(`download appeared to succeed but file missing: ${(err as Error).message}`)
  }
  if (bytes > MAX_BYTES) {
    await rm(path, { force: true }).catch(() => {})
    throw new Error(`payload exceeds ${MAX_BYTES} bytes (got ${bytes})`)
  }

  log.info({ event: 'media.downloaded', path, bytes }, 'media saved')
  return { path, bytes }
}

/**
 * Spawn curl to fetch `url` directly to `outPath`. Resolves on exit code 0,
 * rejects with an Error containing curl's stderr on any other exit. Hard
 * timeout 60 s so a hung connection can't wedge the calling handler.
 *
 * Exposed only inside this module — callers stick to {@link downloadToMediaRoot}.
 */
async function runCurl(url: string, outPath: string): Promise<void> {
  const args = [
    '--silent',
    '--show-error',
    '--fail',                                  // non-2xx → exit code 22
    '--location',                              // follow redirects
    '--max-time', '60',
    '--max-filesize', String(MAX_BYTES),
    '--output', outPath,
    url,
  ]
  return new Promise<void>((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      // Best-effort partial-file cleanup
      void rm(outPath, { force: true }).catch(() => {})
      settle(() => reject(new Error('curl wall-clock timeout (60s)')))
    }, 65 * 1000)
    child.stderr.on('data', (b: Buffer) => stderr.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      void rm(outPath, { force: true }).catch(() => {})
      settle(() => reject(new Error(`curl spawn failed: ${e.message}`)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        settle(() => resolve())
        return
      }
      void rm(outPath, { force: true }).catch(() => {})
      const msg = Buffer.concat(stderr).toString().trim().slice(0, 400) || `curl exit ${code}`
      settle(() => reject(new Error(msg)))
    })
  })
}

/**
 * Walk MEDIA_ROOT recursively, removing regular files older than `maxAgeMs`.
 * Empty directories are also pruned. Errors on a single file are logged and
 * ignored — cleanup must never block the IM pipeline.
 */
export async function cleanupOldMedia(maxAgeMs: number = DEFAULT_TTL_MS): Promise<{ deleted: number; kept: number }> {
  let deleted = 0
  let kept = 0
  const cutoff = Date.now() - maxAgeMs
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        // Try to remove dir if it became empty; ignore failures.
        try {
          const left = await readdir(full)
          if (left.length === 0) await rm(full, { recursive: true })
        } catch { /* ignore */ }
      } else if (entry.isFile()) {
        try {
          const st = await stat(full)
          if (st.mtimeMs < cutoff) {
            await rm(full, { force: true })
            deleted += 1
          } else {
            kept += 1
          }
        } catch { /* ignore */ }
      }
    }
  }
  await walk(MEDIA_ROOT)
  if (deleted > 0) {
    log.info({ event: 'media.cleanup', deleted, kept, maxAgeMs }, 'media cleanup pass')
  }
  return { deleted, kept }
}

/**
 * Pick a filename extension from a TG `file_path` (e.g. "photos/file_123.jpg")
 * or a mime-type like "image/png". Falls back to "bin" so we always have an
 * extension on disk for easier debugging.
 */
export function pickExtension(filePath: string | undefined, mime: string | undefined): string {
  if (filePath) {
    const m = /\.([a-z0-9]+)$/i.exec(filePath)
    if (m) return m[1].toLowerCase()
  }
  if (mime) {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
    }
    if (map[mime.toLowerCase()]) return map[mime.toLowerCase()]
    const m = /\/([a-z0-9]+)$/i.exec(mime)
    if (m) return m[1].toLowerCase()
  }
  return 'bin'
}
