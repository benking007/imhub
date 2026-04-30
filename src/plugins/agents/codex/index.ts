// OpenAI Codex CLI agent adapter
// Uses `codex exec --json` for programmatic interaction

import { AgentBase } from '../../../core/agent-base.js'

interface CodexEvent {
  type: string
  message?: { content?: Array<{ type: string; text?: string }> } | string
  text?: string
  error?: string
  error_message?: string
}

export class CodexAdapter extends AgentBase {
  readonly name = 'codex'
  readonly aliases = ['cx', 'openai', 'codexcli']

  protected buildArgs(prompt: string): string[] {
    return ['exec', '--json', '--full-auto', '--skip-git-repo-check', prompt]
  }

  protected extractText(event: unknown): string {
    const e = event as CodexEvent
    if (e.type === 'message' && e.message && typeof e.message === 'object' && e.message.content) {
      const parts: string[] = []
      for (const item of e.message.content) {
        if (item.type === 'text' && item.text) parts.push(item.text)
      }
      return parts.join('')
    }
    if (e.text) return e.text
    if (typeof e.message === 'string') return e.message
    return ''
  }

  protected handleError(_code: number, _stderr: string, errorMessage: string): string | null {
    if (errorMessage.includes('expired') || errorMessage.includes('过期')) return '❌ Codex 账号已过期\n\n请运行 `codex login` 重新登录。'
    if (errorMessage.includes('not found') || errorMessage.includes('不存在')) return '❌ Codex 用户不存在，请重新登录\n\n请运行 `codex login` 重新登录。'
    return null
  }
}

export const codexAdapter = new CodexAdapter()
