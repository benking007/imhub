// OpenCodeAdapter — verify session-id capture, --session injection, and
// usage callbacks. The adapter is the only piece in the v2 chain that turns
// opencode's `--format json` event stream into the per-agent session row in
// im-hub, so this is the regression net for the 2026-05-02 wire-up.

import { describe, it, expect } from 'bun:test'
import { OpenCodeAdapter } from './index.js'
import type { AgentSendOpts } from '../../../core/types.js'

// Reach past the protected modifier to drive the adapter directly without
// spawning real opencode.
function inspect(adapter: OpenCodeAdapter, event: unknown, opts: AgentSendOpts): void {
  // @ts-expect-error — protected hook, intentional reach for tests
  adapter.inspectEvent(event, opts)
}

function buildArgs(adapter: OpenCodeAdapter, prompt: string, opts: AgentSendOpts): string[] {
  // @ts-expect-error — protected
  return adapter.buildArgs(prompt, opts)
}

describe('OpenCodeAdapter buildArgs', () => {
  it('starts a fresh session when no agentSessionId provided', () => {
    const adapter = new OpenCodeAdapter()
    const args = buildArgs(adapter, 'hello', {})
    expect(args).not.toContain('--session')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('injects --session <id> when opts.agentSessionId is set', () => {
    const adapter = new OpenCodeAdapter()
    const args = buildArgs(adapter, 'hello', { agentSessionId: 'ses_abc' })
    const idx = args.indexOf('--session')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('ses_abc')
  })

  it('still passes model and variant alongside --session', () => {
    const adapter = new OpenCodeAdapter()
    const args = buildArgs(adapter, 'p', {
      agentSessionId: 'ses_abc', model: 'anthropic/claude-sonnet-4-6', variant: 'high',
    })
    expect(args).toContain('--session')
    expect(args).toContain('--model')
    expect(args).toContain('--variant')
  })

  it('injects --agent plan when planMode is true', () => {
    const adapter = new OpenCodeAdapter()
    const args = buildArgs(adapter, 'design X', { planMode: true })
    const idx = args.indexOf('--agent')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('plan')
    // Prompt is still last positional.
    expect(args[args.length - 1]).toBe('design X')
  })

  it('does not pass --agent when planMode is false / unset', () => {
    const adapter = new OpenCodeAdapter()
    expect(buildArgs(adapter, 'p', {})).not.toContain('--agent')
    expect(buildArgs(adapter, 'p', { planMode: false })).not.toContain('--agent')
  })
})

describe('OpenCodeAdapter inspectEvent — session id capture', () => {
  it('forwards sessionID via opts.onAgentSessionId', () => {
    const adapter = new OpenCodeAdapter()
    const ids: string[] = []
    inspect(adapter, { type: 'step_start', sessionID: 'ses_x' }, {
      onAgentSessionId: (id) => ids.push(id),
    })
    expect(ids).toEqual(['ses_x'])
  })

  it('fires every time it sees sessionID — caller dedupes', () => {
    const adapter = new OpenCodeAdapter()
    const ids: string[] = []
    const opts: AgentSendOpts = { onAgentSessionId: (id) => ids.push(id) }
    inspect(adapter, { type: 'step_start', sessionID: 'ses_x' }, opts)
    inspect(adapter, { type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'hi' } }, opts)
    inspect(adapter, { type: 'step_finish', sessionID: 'ses_x' }, opts)
    // 3 events, all carry ses_x. Adapter forwards each — setOpencodeSessionId
    // is itself idempotent so this is safe.
    expect(ids.length).toBe(3)
    expect(new Set(ids).size).toBe(1)
  })

  it('does nothing when callback is absent', () => {
    const adapter = new OpenCodeAdapter()
    // Should not throw
    inspect(adapter, { type: 'step_start', sessionID: 'ses_x' }, {})
  })

  it('survives a callback that throws', () => {
    const adapter = new OpenCodeAdapter()
    inspect(adapter, { type: 'step_start', sessionID: 'ses_x' }, {
      onAgentSessionId: () => { throw new Error('boom') },
    })
    // No assertion — the absence of an unhandled throw is the assertion.
    expect(true).toBe(true)
  })
})

describe('OpenCodeAdapter inspectEvent — usage capture', () => {
  // Reproduces the exact shape opencode 1.14.x emits — cost and tokens
  // are nested under `part`, not on the event root. The first cut of this
  // adapter read them from the root, silently zeroing /stats.
  it('forwards cost + tokens from step_finish (event.part.cost / .tokens)', () => {
    const adapter = new OpenCodeAdapter()
    const deltas: Array<{ costUsd?: number; tokensInput?: number; tokensOutput?: number }> = []
    inspect(adapter, {
      type: 'step_finish',
      sessionID: 'ses_x',
      part: {
        type: 'step-finish',
        tokens: { input: 100, output: 50, total: 150 },
        cost: 0.0123,
      },
    }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(1)
    expect(deltas[0].costUsd).toBe(0.0123)
    expect(deltas[0].tokensInput).toBe(100)
    expect(deltas[0].tokensOutput).toBe(50)
  })

  it('does NOT misread cost/tokens placed at event root (regression guard)', () => {
    const adapter = new OpenCodeAdapter()
    const deltas: Array<{ costUsd?: number; tokensInput?: number }> = []
    // Some hypothetical future format that flattens to root — should NOT
    // accidentally match. This locks in the part-nested expectation.
    inspect(adapter, {
      type: 'step_finish',
      sessionID: 'ses_x',
      // Purposely misshapen — properties at root instead of nested under part.
      cost: 99,
      tokens: { input: 999 },
    } as unknown, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })

  it('does NOT fire onUsage for non-step_finish events', () => {
    const adapter = new OpenCodeAdapter()
    const deltas: unknown[] = []
    inspect(adapter, { type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'hi' } },
      { onUsage: (d) => deltas.push(d) })
    inspect(adapter, { type: 'step_start', sessionID: 'ses_x' },
      { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })

  it('skips onUsage when step_finish carries no cost/tokens', () => {
    const adapter = new OpenCodeAdapter()
    const deltas: unknown[] = []
    inspect(adapter, { type: 'step_finish', sessionID: 'ses_x' },
      { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })
})
