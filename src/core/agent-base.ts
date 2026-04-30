// AgentBase — base class for CLI-based agent adapters
//
// Provides unified: isAvailable (spawn check), sendPrompt (spawn + JSONL parse),
// buildContextualPrompt, timeout management, and session tracking.
//
// Subclasses override: buildArgs(), extractText().

import type { AgentAdapter, ChatMessage } from './types.js'
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

export abstract class AgentBase implements AgentAdapter {
  abstract readonly name: string
  abstract readonly aliases: string[]

  /** Binary name to check for isAvailable */
  protected get commandName(): string { return this.name }

  /** Build CLI args array for a given prompt. */
  protected abstract buildArgs(prompt: string): string[]

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

  async *sendPrompt(_sessionId: string, prompt: string, history?: ChatMessage[]): AsyncGenerator<string> {
    rootLogger.info({ component: `agent.${this.name}`, agent: this.name, historyLen: history?.length || 0 },
      `[${this.name}] sendPrompt`)

    const contextualPrompt = this.buildContextualPrompt(prompt, history)
    const result = await this.spawnAndCollect(contextualPrompt)

    if (result) {
      yield result
    }
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
   * Spawn the CLI process with JSONL output, collect full text via extractText.
   */
  protected spawnAndCollect(prompt: string): Promise<string> {
    const timeout = this.timeoutMs

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt)
      const proc = crossSpawn(this.commandName, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let fullText = ''
      let errorMessage = ''
      let resolved = false

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, timeoutMs: timeout },
            `[${this.name}] timeout after ${Math.round(timeout / 60000)}min`)
          proc.kill('SIGTERM')
          setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* ignore */ }
          }, 5000)
          resolve(fullText
            ? fullText + `\n\n⚠️ 处理超时（已超过 ${Math.round(timeout / 60000)} 分钟），以上为超时前已收到的部分结果。`
            : `⚠️ 处理超时（已超过 ${Math.round(timeout / 60000)} 分钟），agent 未能在规定时间内完成。`)
        }
      }, timeout)

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'error') {
              errorMessage = event.error || event.message || `${event.type} event`
            }
            const text = this.extractText(event)
            if (text) fullText += text
          } catch {
            fullText += line + '\n'
          }
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        console.error(`[${this.name} stderr]`, data.toString())
      })

      proc.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        reject(err)
      })

      proc.on('close', (code) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        rootLogger.info({
          component: `agent.${this.name}`,
          agent: this.name,
          exitCode: code,
          responseLen: fullText.length,
        }, `[${this.name}] process closed`)

        if (code !== 0) {
          const friendlyError = this.handleError(code === null ? -1 : code, stderr, errorMessage)
          if (friendlyError !== null) {
            resolve(friendlyError)
            return
          }
          let detail = ''
          if (errorMessage) detail = errorMessage
          if (!detail && stderr.trim() && stderr.trim().length < 200) detail = stderr.trim()
          resolve(`${this.name} failed (exit ${code})${detail ? ': ' + detail : ''}`)
          return
        }

        resolve(fullText.trim())
      })
    })
  }
}
