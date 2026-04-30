// Claude Code agent adapter
// Uses --print --output-format stream-json for programmatic interaction

import type { ChatMessage } from '../../../core/types.js'
import { AgentBase } from '../../../core/agent-base.js'

interface ClaudeEvent {
  type: string
  message?: {
    content: Array<{ type: string; text?: string; thinking?: string }>
    role: string
  }
}

export class ClaudeCodeAdapter extends AgentBase {
  readonly name = 'claude-code'
  readonly aliases = ['cc', 'claude', 'claudecode']

  protected get commandName(): string { return 'claude' }

  protected buildArgs(prompt: string): string[] {
    return ['--print', '--verbose', '--output-format', 'stream-json', prompt]
  }

  protected extractText(event: unknown): string {
    const msg = event as ClaudeEvent
    if (msg.type === 'assistant' && msg.message?.content) {
      const parts: string[] = []
      for (const item of msg.message.content) {
        if (item.type === 'text' && item.text) parts.push(item.text)
      }
      return parts.join('')
    }
    return ''
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter()
