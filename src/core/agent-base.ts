// AgentBase — base class for CLI-based agent adapters
//
// Provides a unified streaming JSONL invocation pipeline:
//   sendPrompt        — true AsyncGenerator that yields chunks live
//   spawnAndCollect   — Promise<string> wrapper for job-board / sync calls
//   isAvailable       — `--version` probe
//   buildContextualPrompt / buildArgs / extractText — subclass hooks
//
// Subclasses must implement: buildArgs(), extractText().
// Optional override: handleError(), notAvailableMessage(), commandName.

import { StringDecoder } from 'string_decoder'
import type { AgentAdapter, AgentSendOpts, ChatMessage } from './types.js'
import { crossSpawn } from '../utils/cross-platform.js'
import { logger as rootLogger } from './logger.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Resolve per-agent timeout: env var AGENT_TIMEOUT_MS or class default */
function resolveTimeout(envKey: string, fallback: number): number {
  const raw = process.env[envKey]
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
    rootLogger.warn({ event: 'agent.timeout.invalid', raw, envKey, fallback },
      `Invalid timeout env "${envKey}=${raw}", using default ${Math.round(fallback / 60000)}min`)
  }
  return fallback
}

/**
 * Buffer line splitter that respects UTF-8 multi-byte boundaries.
 *
 * Holds a single `partial` string of bytes seen so far without a newline
 * boundary. push(chunk) returns any complete lines found in
 * partial+chunk, and resets partial to the remainder.
 *
 * Implementation notes:
 *   - Uses StringDecoder so a 3-byte CJK codepoint split across chunks
 *     stays whole (no U+FFFD).
 *   - Skips the partial+chunk concat when the chunk has no newline AND
 *     partial is empty (the common case for tiny chunks).
 *   - Walks via indexOf + slice instead of String.split so we avoid
 *     allocating an intermediate array of every line just to pop the
 *     last one back into partial.
 */
class LineBuffer {
  private decoder = new StringDecoder('utf8')
  private partial = ''

  push(chunk: Buffer): string[] {
    const decoded = this.decoder.write(chunk)
    if (!decoded) return []

    if (decoded.indexOf('\n') === -1) {
      // No newline in this chunk — extend partial. V8 ropes strings, so
      // the concat is amortized O(1) here.
      this.partial += decoded
      return []
    }

    const data = this.partial.length === 0 ? decoded : this.partial + decoded
    const out: string[] = []
    let start = 0
    let nl: number
    while ((nl = data.indexOf('\n', start)) !== -1) {
      out.push(data.slice(start, nl))
      start = nl + 1
    }
    this.partial = start < data.length ? data.slice(start) : ''
    return out
  }

  flush(): string[] {
    const tail = this.decoder.end()
    const data = this.partial.length === 0 ? tail : this.partial + tail
    this.partial = ''
    if (data.length === 0) return []

    const out: string[] = []
    let start = 0
    let nl: number
    while ((nl = data.indexOf('\n', start)) !== -1) {
      if (nl > start) out.push(data.slice(start, nl))
      start = nl + 1
    }
    if (start < data.length) out.push(data.slice(start))
    return out
  }
}

/** Internal record of a single streaming agent run. */
export interface SpawnEvent {
  /** Text chunk to surface to the caller. */
  text: string
}

/**
 * Self-contained description of a single CLI invocation. Returned by
 * prepareCommand() and consumed by spawnStream(). All per-call state lives
 * here — never on the adapter instance — so concurrent sendPrompt() calls
 * (which is the norm: one IM thread per chat) cannot clobber each other.
 */
export interface SpawnPlan {
  args: string[]
  /** Extra env merged onto process.env for this spawn. */
  extraEnv?: Record<string, string>
  /** Always called once after the CLI exits, even on error/timeout/abort. */
  cleanup?: () => void | Promise<void>
}

export abstract class AgentBase implements AgentAdapter {
  abstract readonly name: string
  abstract readonly aliases: string[]

  /** Binary name to check for isAvailable */
  protected get commandName(): string { return this.name }

  /**
   * Build CLI args. Pass the per-call opts so model/variant/etc. flow through
   * without needing instance state. Subclasses doing only synchronous arg
   * construction can stay here; for async setup (temp files, registry
   * writes) override prepareCommand() instead.
   */
  protected abstract buildArgs(prompt: string, opts: AgentSendOpts): string[]

  /**
   * Returns a complete spawn plan. Default implementation just wraps
   * buildArgs(). Subclasses needing per-call temp resources (mcp-config
   * file, registered run id, etc.) should override and put ALL derived
   * state inside the returned plan / closure — never on `this`, since
   * concurrent spawns would race.
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    return { args: this.buildArgs(prompt, opts) }
  }

  /** Extract text content from a JSONL event object. */
  protected abstract extractText(event: unknown): string

  /** Optional: transform error info into a user-friendly message string (resolved instead of rejected). */
  protected handleError(_code: number, _stderr: string, _errorMessage: string): string | null {
    return null // default: reject
  }

  /** Optional: return user-friendly unavailable message. */
  protected notAvailableMessage(): string {
    return `${this.name} CLI not found. Please install it.`
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  /** Lightweight health probe (same as isAvailable for CLI agents). */
  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now()
    const ok = await this.isAvailable()
    return { ok, latencyMs: Date.now() - start }
  }

  /**
   * Stream JSONL chunks live. Yields each `extractText` result as it
   * arrives; on non-zero exit, yields the friendly error tail (if any) and
   * returns.
   */
  async *sendPrompt(_sessionId: string, prompt: string, history?: ChatMessage[], opts?: AgentSendOpts): AsyncGenerator<string> {
    rootLogger.info({ component: `agent.${this.name}`, agent: this.name, historyLen: history?.length || 0 },
      `[${this.name}] sendPrompt`)
    const contextualPrompt = this.buildContextualPrompt(prompt, history)
    yield* this.spawnStream(contextualPrompt, undefined, opts || {})
  }

  /**
   * Build prompt with conversation history context.
   * Subclasses may override for custom formatting.
   */
  protected buildContextualPrompt(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) {
      return prompt
    }
    const historyText = history
      .map(msg => `[${msg.role === 'user' ? 'User' : 'Assistant'}]: ${msg.content}`)
      .join('\n\n')
    return `Previous conversation context:\n${historyText}\n\nCurrent request: ${prompt}`
  }

  /** Per-agent timeout in ms. Override or set env var (upper-case name + _TIMEOUT_MS). */
  protected get timeoutMs(): number {
    return resolveTimeout(`${this.name.toUpperCase()}_TIMEOUT_MS`, DEFAULT_TIMEOUT_MS)
  }

  /**
   * Sync convenience wrapper: drain the streaming generator into a single
   * string. Used by Job Board where the caller wants the final result.
   */
  public async spawnAndCollect(prompt: string, signal?: AbortSignal): Promise<string> {
    let acc = ''
    for await (const chunk of this.spawnStream(prompt, signal, {})) {
      acc += chunk
    }
    return acc
  }

  /**
   * Core streaming pipeline: spawn the CLI, parse JSONL line-by-line, yield
   * each extracted text fragment. Handles timeout, abort, and process exit
   * with cleanup of all timers and listeners.
   */
  protected async *spawnStream(prompt: string, signal?: AbortSignal, opts: AgentSendOpts = {}): AsyncGenerator<string> {
    const timeout = this.timeoutMs

    // prepareCommand returns a self-contained plan — args, optional extra env,
    // optional cleanup. No instance state involved, so concurrent spawnStream
    // calls cannot race each other. (Previously setupSpawn() would mutate
    // this.mcpConfigPath etc. between awaits, leading to two parallel claude
    // runs sharing one mcp.json and the second one finding it already deleted.)
    let plan: SpawnPlan
    try {
      plan = await this.prepareCommand(prompt, opts)
    } catch (err) {
      throw err
    }

    const proc = crossSpawn(this.commandName, plan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: plan.extraEnv ? { ...process.env, ...plan.extraEnv } : undefined,
    })

    const buf = new LineBuffer()
    const stderrBuf = new LineBuffer()
    let stderrAccum = ''
    let errorMessage = ''
    let pendingChunks: string[] = []
    let closed = false
    let exitCode: number | null = null
    let spawnError: Error | null = null
    let timedOut = false
    let aborted = false

    // Each `notify` resolves the current poll cycle; the consumer awaits a
    // promise that flips whenever new state is available.
    let notify: (() => void) | null = null
    const wait = (): Promise<void> => new Promise((resolve) => { notify = resolve })
    const ping = (): void => { const n = notify; notify = null; n?.() }

    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      ping()
    }, timeout)

    let killTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleKill = (): void => {
      if (killTimer) return
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }, 5000)
    }

    const onAbort = (): void => {
      aborted = true
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      scheduleKill()
      ping()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = buf.push(data)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event && typeof event === 'object' && (event as Record<string, unknown>).type === 'error') {
            const e = event as Record<string, unknown>
            errorMessage = (e.error as string) || (e.message as string) || 'error event'
            // Don't yield error event content alongside extractText
            continue
          }
          const text = this.extractText(event)
          if (text) pendingChunks.push(text)
        } catch {
          // Non-JSON line — pass through verbatim with newline preserved
          pendingChunks.push(line + '\n')
        }
      }
      if (pendingChunks.length > 0) ping()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderrAccum += data.toString()
      // Surface to root logger as warn — pino-aware, no console.error noise
      for (const line of stderrBuf.push(data)) {
        if (line.trim()) {
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, stderr: line }, `[${this.name}] stderr`)
        }
      }
    })

    proc.on('error', (err) => {
      spawnError = err
      closed = true
      ping()
    })

    proc.on('close', (code) => {
      exitCode = code
      closed = true
      // Flush any remaining stderr line
      for (const line of stderrBuf.flush()) {
        if (line.trim()) {
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, stderr: line }, `[${this.name}] stderr`)
        }
      }
      // Flush any non-newline-terminated tail in stdout buffer
      for (const line of buf.flush()) {
        try {
          const event = JSON.parse(line)
          const text = this.extractText(event)
          if (text) pendingChunks.push(text)
        } catch {
          pendingChunks.push(line)
        }
      }
      ping()
    })

    try {
      while (!closed || pendingChunks.length > 0) {
        if (pendingChunks.length === 0) {
          await wait()
          if (aborted) break
          if (timedOut) break
        }
        // Drain whatever has accumulated this cycle
        const out = pendingChunks
        pendingChunks = []
        for (const c of out) yield c
      }

      if (timedOut) {
        const mins = Math.round(timeout / 60000)
        rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, timeoutMs: timeout },
          `[${this.name}] timeout after ${mins}min`)
        yield `\n\n⚠️ 处理超时（已超过 ${mins} 分钟）`
        return
      }

      if (aborted) {
        rootLogger.info({ component: `agent.${this.name}`, agent: this.name }, `[${this.name}] cancelled via signal`)
        yield '\n\n🚫 任务已被取消。'
        return
      }

      if (spawnError) {
        throw spawnError
      }

      rootLogger.info({
        component: `agent.${this.name}`,
        agent: this.name,
        exitCode,
      }, `[${this.name}] process closed`)

      if (exitCode !== null && exitCode !== 0) {
        const friendly = this.handleError(exitCode, stderrAccum, errorMessage)
        if (friendly !== null) {
          yield friendly
          return
        }
        let detail = ''
        if (errorMessage) detail = errorMessage
        if (!detail && stderrAccum.trim() && stderrAccum.trim().length < 200) {
          detail = stderrAccum.trim()
        }
        yield `${this.name} failed (exit ${exitCode})${detail ? ': ' + detail : ''}`
      }
    } finally {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (plan.cleanup) {
        try { await plan.cleanup() } catch (err) {
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, err: String(err) },
            `[${this.name}] cleanup hook threw`)
        }
      }
    }
  }
}
