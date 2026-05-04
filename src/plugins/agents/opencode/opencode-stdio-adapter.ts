// OpenCode CLI agent adapter — stdio (JSONL) driver.
// Uses `opencode run --format json` for programmatic interaction.
//
// Two flavors of multi-turn continuity, mirroring the claude-code adapter:
//
//   First turn  — no opts.agentSessionId yet. Spawn `opencode run …` plain.
//                 The adapter watches for `sessionID` on the very first event
//                 and reports it back via opts.onAgentSessionId so cli can
//                 persist it on the im-hub Session row.
//   Later turns — opts.agentSessionId is the captured ses_… id. We pass
//                 `--session <id>` so opencode reads the conversation from
//                 its own DB instead of relying on im-hub stitching the
//                 history into the prompt. router.callAgentWithHistory
//                 honours this by zeroing out `effectiveHistory` whenever
//                 `agentSessionResume` is true.
//
// Cost accounting: opencode emits `cost` and `tokens.{input,output}` in
// `step_finish` events. We forward those as opts.onUsage deltas so /stats
// reflects opencode reality (it had been hard-coded to 0 before).
//
// Known limitation (the reason OpenCodeHttpAdapter exists): `opencode run`'s
// stdout JSON stream does NOT emit `permission.asked`, and its inline auto-
// reject logic occasionally fails to release the prompt deferred. Result:
// process hangs until the 30-min hard timeout fires. The HTTP driver fixes
// this at the root by driving opencode via its REST + SSE API instead.

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'

interface OpenCodeEvent {
  type: string
  sessionID?: string
  content?: string
  text?: string
  /**
   * The actual event payload. opencode wraps every meaningful field
   * (text body, cost, tokens, reason) inside `part`, not the top-level
   * event. The outer event only carries `type` / `sessionID` / `timestamp`.
   * Getting this wrong is silently 0 on /stats — we did exactly that in
   * the first cut of this adapter.
   */
  part?: {
    type: string
    text?: string
    tokens?: { input?: number; output?: number; total?: number; reasoning?: number }
    cost?: number
  }
}

export class OpenCodeAdapter extends AgentBase {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['run', '--format', 'json']
    if (opts.agentSessionId) args.push('--session', opts.agentSessionId)
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

  /**
   * Pull metadata out of every event:
   *   - `sessionID` on any event → bubble up via opts.onAgentSessionId so cli
   *     can persist it. Idempotent (the callback handles dedup).
   *   - `cost` / `tokens` on `step_finish` → bubble up via opts.onUsage so
   *     callAgentWithHistory can roll into /stats.
   */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as OpenCodeEvent
    if (e.sessionID && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(e.sessionID) } catch { /* don't let userland callbacks kill the stream */ }
    }
    if (e.type === 'step_finish' && opts.onUsage) {
      // cost / tokens are NESTED inside event.part, not on the event itself.
      const part = e.part
      const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
      if (typeof part?.cost === 'number' && Number.isFinite(part.cost)) delta.costUsd = part.cost
      if (typeof part?.tokens?.input === 'number') delta.tokensInput = part.tokens.input
      if (typeof part?.tokens?.output === 'number') delta.tokensOutput = part.tokens.output
      if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* same — user callback safety */ }
      }
    }
  }
}
