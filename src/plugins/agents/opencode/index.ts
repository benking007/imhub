// OpenCode CLI agent adapter
// Uses `opencode run --format json` for programmatic interaction

import type { AgentAdapter, ChatMessage } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { logger } from '../../../core/logger.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

function resolveTimeout(): number {
  const raw = process.env.OPENCODE_TIMEOUT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) {
      return n
    }
    logger.warn({
      event: 'opencode.timeout.invalid',
      raw,
      parsed: n,
      fallback: DEFAULT_TIMEOUT_MS,
    }, `Invalid OPENCODE_TIMEOUT_MS="${raw}", using default ${Math.round(DEFAULT_TIMEOUT_MS / 60000)}min`)
  }
  return DEFAULT_TIMEOUT_MS
}

interface OpenCodePart {
  type: string
  text?: string
}

interface OpenCodeEvent {
  type: string
  content?: string
  text?: string
  message?: string
  error?: string
  part?: OpenCodePart
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn('opencode', ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  async *sendPrompt(_sessionId: string, prompt: string, history?: ChatMessage[]): AsyncGenerator<string> {
    console.log(`[OpenCode] sendPrompt called, prompt: ${prompt}, history: ${history?.length || 0} messages`)

    // Build prompt with conversation context
    const contextualPrompt = this.buildContextualPrompt(prompt, history)

    const response = await this.callOpenCode(contextualPrompt)
    console.log(`[OpenCode] Response length: ${response.length}`)

    if (response) {
      yield response
    }
  }

  /**
   * Build prompt with conversation history context
   */
  private buildContextualPrompt(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) {
      return prompt
    }

    const historyText = history
      .map(msg => `[${msg.role === 'user' ? 'User' : 'Assistant'}]: ${msg.content}`)
      .join('\n\n')

    return `Previous conversation context:
${historyText}

Current request: ${prompt}`
  }

  private callOpenCode(prompt: string): Promise<string> {
    const timeoutMs = resolveTimeout()

    return new Promise((resolve, reject) => {
      const proc = crossSpawn('opencode', [
        'run',
        '--format', 'json',
        prompt,
      ], {
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
          proc.kill('SIGTERM')
          setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* ignore */ }
          }, 5000)
          resolve(fullText.length
            ? `${fullText}\n\n⚠️ 处理超时（已超过 ${Math.round(timeoutMs / 60000)} 分钟），以上为超时前已收到的部分结果。`
            : `⚠️ 处理超时（已超过 ${Math.round(timeoutMs / 60000)} 分钟），agent 未能在规定时间内完成。请简化问题后重试。`)
        }
      }, timeoutMs)

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue

          try {
            const event: OpenCodeEvent = JSON.parse(line)
            console.log('[OpenCode] Event type:', event.type)

            if (event.type === 'error') {
              errorMessage = event.error || event.message || 'Unknown error'
            }

            const text = this.extractText(event)
            if (text) {
              fullText += text
            }
          } catch {
            // Skip malformed JSON
          }
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        console.error('[OpenCode stderr]', data.toString())
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
        console.log('[OpenCode] Process closed, code:', code)
        if (code !== 0) {
          let errorMsg = 'OpenCode 执行失败'
          if (errorMessage.includes('auth') || errorMessage.includes('login')) {
            errorMsg = 'OpenCode 未登录或认证已过期'
          } else if (errorMessage.includes('API') || errorMessage.includes('key')) {
            errorMsg = 'OpenCode API 密钥无效'
          } else if (errorMessage.length > 0 && errorMessage.length < 100) {
            errorMsg = errorMessage
          }
          resolve(`❌ OpenCode 错误: ${errorMsg}\n\n请运行 \`opencode auth login\` 配置认证。`)
        } else {
          resolve(fullText)
        }
      })
    })
  }

  private extractText(event: OpenCodeEvent): string {
    if (event.type === 'text' && event.part?.text) {
      return event.part.text
    }

    if (event.type === 'content' && event.content) {
      return event.content
    }

    return ''
  }
}

// Singleton instance
export const opencodeAdapter = new OpenCodeAdapter()
