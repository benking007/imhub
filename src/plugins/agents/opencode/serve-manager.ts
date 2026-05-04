// OpencodeServeManager — lazy-launches and supervises a single
// `opencode serve` daemon that the HTTP adapter and the IM permission
// bridge talk to.
//
// Design notes:
//   - Singleton per im-hub process. Multiple IM threads share one daemon —
//     opencode's session model is per-session anyway, so collisions don't
//     happen on the wire.
//   - First call to ensureRunning() starts the child; readiness is detected
//     by watching stderr for "listening on http://…" (the line opencode emits
//     unconditionally) and falling back to an HTTP probe if that's missed.
//   - If the child dies, the next ensureRunning() respawns. We don't
//     auto-restart in the background — silent restart loops hide problems.
//   - Bound to 127.0.0.1 by default. The server warns about
//     OPENCODE_SERVER_PASSWORD being unset; we silence that intentionally
//     since the surface is loopback only. Set it via env if you expose the
//     port off-host.

import { crossSpawn } from '../../../utils/cross-platform.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { ChildProcess } from 'child_process'

const log = rootLogger.child({ component: 'opencode.serve' })

const READY_TIMEOUT_MS = 15_000
const READY_REGEX = /listening on (https?:\/\/[^\s]+)/i

export interface ServeOptions {
  /** Port to bind. Default: env IMHUB_OPENCODE_PORT or 14199. */
  port?: number
  /** Host to bind. Default: 127.0.0.1. */
  hostname?: string
  /** cwd for the spawn. Has no effect on per-session directory (sessions are
   *  created with their own directory) but determines where opencode looks
   *  for its global config. Default: process.cwd(). */
  cwd?: string
}

export class OpencodeServeManager {
  private child: ChildProcess | null = null
  private baseUrl: string | null = null
  private startPromise: Promise<string> | null = null
  private readonly opts: Required<Pick<ServeOptions, 'port' | 'hostname'>> & ServeOptions

  constructor(opts: ServeOptions = {}) {
    const envPort = process.env.IMHUB_OPENCODE_PORT
    this.opts = {
      port: opts.port ?? (envPort ? parseInt(envPort, 10) : 14199),
      hostname: opts.hostname ?? '127.0.0.1',
      cwd: opts.cwd,
    }
  }

  /** Start the daemon if needed and return the base URL once ready. Idempotent. */
  ensureRunning(): Promise<string> {
    if (this.baseUrl && this.child && !this.child.killed) {
      return Promise.resolve(this.baseUrl)
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.spawnAndWait().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.baseUrl !== null
  }

  getBaseUrl(): string | null { return this.baseUrl }

  /** Stop the daemon. Used by tests and on im-hub shutdown. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.baseUrl = null
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, 2000)
      child.once('close', () => {
        clearTimeout(kill)
        resolve()
      })
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    })
  }

  private async spawnAndWait(): Promise<string> {
    const { port, hostname, cwd } = this.opts
    const candidateUrl = `http://${hostname}:${port}`

    // Probe before spawn: a previous im-hub run (or our own restart) may have
    // left a healthy `opencode serve` on the same port. Spawning a second one
    // would just bind-fail with code=1 and break the next user message — we
    // saw exactly that in audit row 309 on 2026-05-04. If the port answers
    // and the response looks like opencode, reuse it instead.
    if (await probeOpencodeServe(candidateUrl)) {
      this.baseUrl = candidateUrl
      log.info({ event: 'opencode.serve.reused', baseUrl: candidateUrl },
        'reusing existing opencode serve on configured port')
      return candidateUrl
    }

    log.info({ event: 'opencode.serve.starting', port, hostname }, 'starting opencode serve')

    const child = crossSpawn(
      'opencode',
      ['serve', '--port', String(port), '--hostname', hostname],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: process.env,
      },
    )
    this.child = child

    let resolved = false
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        log.error({ event: 'opencode.serve.timeout' }, 'opencode serve did not become ready in time')
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error('opencode serve did not become ready within ' + READY_TIMEOUT_MS + 'ms'))
      }, READY_TIMEOUT_MS)

      const onLine = (line: string): void => {
        const m = line.match(READY_REGEX)
        if (m && !resolved) {
          resolved = true
          clearTimeout(timer)
          this.baseUrl = m[1].replace(/\/+$/, '')
          log.info({ event: 'opencode.serve.ready', baseUrl: this.baseUrl }, 'opencode serve ready')
          resolve(this.baseUrl)
        }
      }

      const stderr = child.stderr
      const stdout = child.stdout
      let stderrBuf = ''
      let stdoutBuf = ''

      stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString('utf8')
        let nl: number
        while ((nl = stderrBuf.indexOf('\n')) !== -1) {
          const line = stderrBuf.slice(0, nl)
          stderrBuf = stderrBuf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      })
      stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString('utf8')
        let nl: number
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl)
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      })

      child.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        reject(err)
      })

      child.on('close', (code, signal) => {
        log.warn({ event: 'opencode.serve.exited', code, signal }, 'opencode serve exited')
        if (this.child === child) {
          this.child = null
          this.baseUrl = null
        }
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          reject(new Error(`opencode serve exited before ready (code=${code}, signal=${signal})`))
        }
      })
    })

    return ready
  }
}

/**
 * Probe a candidate URL: if `GET /` returns 2xx within ~500ms, treat the
 * port as already serving an opencode instance we can reuse. We don't try
 * to fingerprint the response body — the localhost-only attack surface
 * doesn't justify it; if some other service happens to listen on the
 * configured port the reuse path will fail later when /event is hit and
 * the adapter surfaces a clear error to the user.
 */
async function probeOpencodeServe(baseUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(baseUrl + '/', { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Process-wide singleton. Tests can `new OpencodeServeManager()` on their own. */
export const opencodeServe = new OpencodeServeManager()
