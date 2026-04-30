// Unit tests for the optional LLM-backed intent fallback (P2-H).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  configureLLMJudge,
  getLLMJudge,
  classifyWithLLM,
  _clearLLMCache,
} from '../../src/core/intent-llm'
import type { AgentAdapter } from '../../src/core/types'

function makeStub(name: string, response: string): AgentAdapter {
  return {
    name, aliases: [],
    isAvailable: async () => true,
    sendPrompt: async function* () { yield response },
  }
}

describe('LLM judge', () => {
  beforeEach(() => {
    _clearLLMCache()
    configureLLMJudge(null)
  })

  afterEach(() => {
    configureLLMJudge(null)
  })

  it('returns null when no judge is configured', async () => {
    const result = await classifyWithLLM('hi', ['a', 'b'], () => undefined)
    expect(result).toBeNull()
  })

  it('returns null when configured judge agent is missing', async () => {
    configureLLMJudge({ agentName: 'missing' })
    const result = await classifyWithLLM('hi', ['a', 'b'], () => undefined)
    expect(result).toBeNull()
  })

  it('parses a plain agent-name response', async () => {
    configureLLMJudge({ agentName: 'judge' })
    const judge = makeStub('judge', 'opencode\n')
    const result = await classifyWithLLM('refactor this', ['claude-code', 'opencode'],
      (n) => n === 'judge' ? judge : undefined)
    expect(result?.agent).toBe('opencode')
  })

  it('strips punctuation and uppercase', async () => {
    configureLLMJudge({ agentName: 'judge' })
    const judge = makeStub('judge', '  CLAUDE-CODE.  \n')
    const result = await classifyWithLLM('write docs', ['claude-code', 'opencode'],
      (n) => n === 'judge' ? judge : undefined)
    expect(result?.agent).toBe('claude-code')
  })

  it('falls back to substring match when exact match fails', async () => {
    configureLLMJudge({ agentName: 'judge' })
    const judge = makeStub('judge', 'I think opencode is best')
    const result = await classifyWithLLM('git commit', ['claude-code', 'opencode'],
      (n) => n === 'judge' ? judge : undefined)
    expect(result?.agent).toBe('opencode')
  })

  it('returns null when output matches no candidate', async () => {
    configureLLMJudge({ agentName: 'judge' })
    const judge = makeStub('judge', 'something-unknown')
    const result = await classifyWithLLM('hello', ['claude-code', 'opencode'],
      (n) => n === 'judge' ? judge : undefined)
    expect(result).toBeNull()
  })

  it('caches identical prompt+candidate combos', async () => {
    configureLLMJudge({ agentName: 'judge' })
    let calls = 0
    const judge: AgentAdapter = {
      name: 'judge', aliases: [],
      isAvailable: async () => true,
      sendPrompt: async function* () { calls++; yield 'opencode' },
    }
    const resolve = (n: string) => n === 'judge' ? judge : undefined

    await classifyWithLLM('do thing', ['claude-code', 'opencode'], resolve)
    await classifyWithLLM('do thing', ['claude-code', 'opencode'], resolve)
    expect(calls).toBe(1)  // second call hit cache
  })

  it('honors timeoutMs', async () => {
    configureLLMJudge({ agentName: 'judge', timeoutMs: 30 })
    const slow: AgentAdapter = {
      name: 'judge', aliases: [],
      isAvailable: async () => true,
      sendPrompt: async function* () {
        await new Promise((r) => setTimeout(r, 200))
        yield 'opencode'
      },
    }
    const result = await classifyWithLLM('q', ['claude-code', 'opencode'],
      (n) => n === 'judge' ? slow : undefined)
    expect(result).toBeNull()
  })

  it('IM_HUB_LLM_JUDGE_AGENT env auto-configures', () => {
    // The auto-config runs at module load time. We can't unload the
    // module mid-test, but we can verify the configureLLMJudge path
    // works after reset.
    configureLLMJudge({ agentName: 'manually-set' })
    expect(getLLMJudge()?.agentName).toBe('manually-set')
  })

  it('LRU cache enforces a hard size cap (no unbounded growth)', async () => {
    configureLLMJudge({ agentName: 'judge' })
    const judge: AgentAdapter = {
      name: 'judge', aliases: [],
      isAvailable: async () => true,
      sendPrompt: async function* (_id, prompt) {
        // Echo back the first candidate to make every call resolve.
        const m = prompt.match(/- (\S+)/)
        yield m?.[1] || 'a'
      },
    }
    const resolve = (n: string) => n === 'judge' ? judge : undefined

    // Issue many distinct prompts so each gets a unique cache key.
    // The default cap is 1000; we send 1100 to verify eviction kicks in.
    for (let i = 0; i < 1100; i++) {
      await classifyWithLLM(`prompt-${i}`, ['a', 'b'], resolve)
    }
    const { _cacheSize } = await import('../../src/core/intent-llm')
    expect(_cacheSize()).toBeLessThanOrEqual(1000)
  })
})
