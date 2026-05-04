// CodexAdapter — verify session-id capture, exec resume args, text extraction,
// and usage callbacks. Mirrors the opencode regression net for codex's
// `--json` event stream (codex 0.128).
//
// Reference event shapes (real codex output):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi!"}}
//   {"type":"turn.completed","usage":{"input_tokens":13299,"cached_input_tokens":11648,"output_tokens":6,"reasoning_output_tokens":0}}

import { describe, it, expect } from 'bun:test'
import { CodexAdapter, _testInternals } from './index.js'
import type { AgentSendOpts } from '../../../core/types.js'

const { buildArgs, extractText, inspectEvent } = _testInternals

describe('CodexAdapter buildArgs', () => {
  it('starts a fresh session when no agentSessionId provided', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'hello', {})
    expect(args[0]).toBe('exec')
    expect(args).not.toContain('resume')
    expect(args).toContain('--json')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('uses `exec resume <id>` when agentSessionId + agentSessionResume are set', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'hello', {
      agentSessionId: '019df376-0ec9-77c3-9d7d-1a15fd8cc9c9',
      agentSessionResume: true,
    })
    expect(args[0]).toBe('exec')
    expect(args[1]).toBe('resume')
    expect(args[2]).toBe('019df376-0ec9-77c3-9d7d-1a15fd8cc9c9')
    expect(args).toContain('--json')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('does NOT use resume when agentSessionId is set without agentSessionResume', () => {
    // Defensive: agentSessionId without resume means "we know the id but
    // codex hasn't been told yet" — happens nowhere in practice but we want
    // a deterministic fallback rather than an undefined positional.
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', { agentSessionId: 'abc' })
    expect(args).not.toContain('resume')
    expect(args[0]).toBe('exec')
  })

  it('keeps --full-auto and --skip-git-repo-check on every call', () => {
    const adapter = new CodexAdapter()
    expect(buildArgs(adapter, 'p', {})).toContain('--full-auto')
    expect(buildArgs(adapter, 'p', {})).toContain('--skip-git-repo-check')
    expect(buildArgs(adapter, 'p', {
      agentSessionId: 'abc', agentSessionResume: true,
    })).toContain('--full-auto')
  })
})

describe('CodexAdapter extractText', () => {
  it('extracts text from item.completed agent_message', () => {
    const adapter = new CodexAdapter()
    const text = extractText(adapter, {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hello world' },
    })
    expect(text).toBe('hello world')
  })

  it('returns empty string for non-agent_message item types', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, {
      type: 'item.completed',
      item: { id: 'item_1', type: 'tool_call', text: 'should not surface' },
    })).toBe('')
  })

  it('returns empty for orchestration events (thread.started / turn.*)', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, { type: 'thread.started', thread_id: 'abc' })).toBe('')
    expect(extractText(adapter, { type: 'turn.started' })).toBe('')
    expect(extractText(adapter, { type: 'turn.completed', usage: { input_tokens: 10 } })).toBe('')
  })

  // Regression guard for the v0 adapter that hunted for {type:"message"} —
  // that event shape never fires in real codex 0.128 output.
  it('does NOT match the legacy {type:"message"} shape', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, {
      type: 'message',
      message: { content: [{ type: 'text', text: 'should-not-match' }] },
    })).toBe('')
  })
})

describe('CodexAdapter inspectEvent — session id capture', () => {
  it('forwards thread_id from thread.started via opts.onAgentSessionId', () => {
    const adapter = new CodexAdapter()
    const ids: string[] = []
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'uuid-1' }, {
      onAgentSessionId: (id) => ids.push(id),
    })
    expect(ids).toEqual(['uuid-1'])
  })

  it('does not fire for events other than thread.started', () => {
    const adapter = new CodexAdapter()
    const ids: string[] = []
    const opts: AgentSendOpts = { onAgentSessionId: (id) => ids.push(id) }
    inspectEvent(adapter, { type: 'turn.started' }, opts)
    inspectEvent(adapter, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hi' },
    }, opts)
    expect(ids.length).toBe(0)
  })

  it('does nothing when callback is absent', () => {
    const adapter = new CodexAdapter()
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'x' }, {})
    // Absence of throw is the assertion.
    expect(true).toBe(true)
  })

  it('survives a callback that throws', () => {
    const adapter = new CodexAdapter()
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'x' }, {
      onAgentSessionId: () => { throw new Error('boom') },
    })
    expect(true).toBe(true)
  })
})

describe('CodexAdapter inspectEvent — usage capture', () => {
  it('forwards input/output tokens from turn.completed.usage', () => {
    const adapter = new CodexAdapter()
    const deltas: Array<{ costUsd?: number; tokensInput?: number; tokensOutput?: number }> = []
    inspectEvent(adapter, {
      type: 'turn.completed',
      usage: {
        input_tokens: 13299,
        cached_input_tokens: 11648,
        output_tokens: 6,
        reasoning_output_tokens: 0,
      },
    }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(1)
    expect(deltas[0].tokensInput).toBe(13299)
    expect(deltas[0].tokensOutput).toBe(6)
    // codex doesn't surface cost — should remain undefined.
    expect(deltas[0].costUsd).toBeUndefined()
  })

  it('does NOT fire onUsage for non-turn.completed events', () => {
    const adapter = new CodexAdapter()
    const deltas: unknown[] = []
    inspectEvent(adapter, { type: 'turn.started' }, { onUsage: (d) => deltas.push(d) })
    inspectEvent(adapter, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hi' },
    }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })

  it('skips onUsage when turn.completed carries no usage block', () => {
    const adapter = new CodexAdapter()
    const deltas: unknown[] = []
    inspectEvent(adapter, { type: 'turn.completed' }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })
})

describe('CodexAdapter prepareCommand', () => {
  it('does not pin cwd for non-IM calls (no threadId/platform)', async () => {
    const adapter = new CodexAdapter()
    const plan = await _testInternals.prepareCommand(adapter, 'p', {})
    expect(plan.cwd).toBeUndefined()
  })

  it('pins cwd to ~/.im-hub-workspaces/codex when threadId+platform present', async () => {
    const adapter = new CodexAdapter()
    const plan = await _testInternals.prepareCommand(adapter, 'p', {
      threadId: 't1', platform: 'wechat', channelId: 'c1', userId: 'u1',
    })
    expect(plan.cwd).toBeDefined()
    expect(plan.cwd!.endsWith('/codex')).toBe(true)
  })
})
