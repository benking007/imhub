// OpenCode CLI agent adapter
// Uses `opencode run --format json` for programmatic interaction

import { AgentBase } from '../../../core/agent-base.js'

interface OpenCodeEvent {
  type: string
  content?: string
  text?: string
  part?: { type: string; text?: string }
}

export class OpenCodeAdapter extends AgentBase {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  protected buildArgs(prompt: string): string[] {
    const args = ['run', '--format', 'json']
    if (this.currentOpts.model) args.push('--model', this.currentOpts.model)
    if (this.currentOpts.variant) args.push('--variant', this.currentOpts.variant)
    args.push(prompt)
    return args
  }

  protected extractText(event: unknown): string {
    const e = event as OpenCodeEvent
    if (e.type === 'text' && e.part?.text) return e.part.text
    if (e.type === 'content' && e.content) return e.content
    return ''
  }
}

export const opencodeAdapter = new OpenCodeAdapter()
