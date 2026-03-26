// Feishu Card Builder
// Builds Feishu interactive card JSON using native elements

import type { FeishuCard, FeishuCardElement, FeishuCardAction } from './types.js'

export class CardBuilder {
  private header: FeishuCard['header']
  private elements: FeishuCardElement[] = []

  withHeader(title: string, template?: string): this {
    this.header = {
      title: { tag: 'plain_text', content: title },
      template
    }
    return this
  }

  addMarkdown(content: string): this {
    this.elements.push({
      tag: 'markdown',
      content
    })
    return this
  }

  addDiv(text: string): this {
    this.elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: text }
    })
    return this
  }

  addCode(code: string, language?: string): this {
    this.elements.push({
      tag: 'code',
      text: { tag: 'plain_text', content: code },
      language
    })
    return this
  }

  addDivider(): this {
    this.elements.push({ tag: 'hr' })
    return this
  }

  addButtons(buttons: Array<{
    text: string
    type: 'primary' | 'default' | 'danger'
    value: Record<string, string>
  }>): this {
    const actions: FeishuCardAction[] = buttons.map(b => ({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: b.text },
      type: b.type,
      value: b.value
    }))

    this.elements.push({
      tag: 'action',
      actions
    })
    return this
  }

  addAgentBadge(agent: string): this {
    const agentEmoji: Record<string, string> = {
      'claude-code': '🧠',
      'codex': '⚡',
      'copilot': '🤖',
      'opencode': '🔧'
    }
    const emoji = agentEmoji[agent] || '🤖'

    this.elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: `${emoji} ${agent}`
      }]
    })
    return this
  }

  build(): FeishuCard {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      elements: this.elements
    }
    if (this.header) {
      card.header = this.header
    }
    return card
  }
}

/**
 * Convert markdown text to Feishu-compatible format
 * Feishu supports most standard markdown in the markdown element
 */
export function markdownToFeishu(text: string): string {
  // Feishu markdown element supports standard markdown
  // Just need to ensure code blocks are properly formatted
  return text
}
