// OpenCode CLI agent adapter
// Uses `opencode run --format json` for programmatic interaction

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'

interface OpenCodeEvent {
  type: string
  content?: string
  text?: string
  part?: { type: string; text?: string }
}

export class OpenCodeAdapter extends AgentBase {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['run', '--format', 'json']
    if (opts.model) args.push('--model', opts.model)
    if (opts.variant) args.push('--variant', opts.variant)
    args.push(prompt)
    return args
  }

  /**
   * opencode keys its per-project AGENTS.md and memory off the spawn cwd,
   * so for IM calls we pin to ~/.im-hub-workspaces/opencode/. Non-IM calls
   * (web/scheduler) keep cwd undefined and inherit im-hub's cwd, preserving
   * the prior behavior. See agent-cwd.ts for full rationale.
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    return {
      args: this.buildArgs(prompt, opts),
      cwd: resolveAgentCwd(this.name, opts),
    }
  }

  protected extractText(event: unknown): string {
    const e = event as OpenCodeEvent
    if (e.type === 'text' && e.part?.text) return e.part.text
    if (e.type === 'content' && e.content) return e.content
    return ''
  }
}

export const opencodeAdapter = new OpenCodeAdapter()
