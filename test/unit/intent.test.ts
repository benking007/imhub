// Unit tests for the rule-based intent classifier

import { describe, it, expect, beforeEach } from 'bun:test'
import { classifyIntent } from '../../src/core/intent'
import { registry } from '../../src/core/registry'
import { circuitBreaker } from '../../src/core/circuit-breaker'
import type { AgentAdapter } from '../../src/core/types'

function makeAgent(name: string, aliases: string[] = []): AgentAdapter {
  return {
    name,
    aliases,
    isAvailable: async () => true,
    sendPrompt: async function* () { yield '' },
  }
}

// Make sure all four profiled agents are registered so PROFILES weights apply.
function registerProfiledAgents(): void {
  registry.registerAgent(makeAgent('opencode', ['oc']))
  registry.registerAgent(makeAgent('claude-code', ['cc']))
  registry.registerAgent(makeAgent('codex', ['cx']))
  registry.registerAgent(makeAgent('copilot', ['co']))
}

describe('classifyIntent', () => {
  beforeEach(() => {
    registerProfiledAgents()
    // Reset breaker state between tests
    for (const a of ['opencode', 'claude-code', 'codex', 'copilot']) {
      circuitBreaker.recordSuccess(a)
    }
  })

  it('throws when no agents are registered/available', () => {
    // Force-open every profiled agent so the available list is empty
    for (const a of ['opencode', 'claude-code', 'codex', 'copilot']) {
      for (let i = 0; i < 3; i++) circuitBreaker.recordFailure(a)
    }
    // Also force-open any other registered agents (e.g. test-agent from earlier suites)
    for (const a of registry.listAgents()) {
      for (let i = 0; i < 3; i++) circuitBreaker.recordFailure(a)
    }
    expect(() => classifyIntent('hello')).toThrow('No agents available')
  })

  it('routes git/commit messages to opencode via topic rule', () => {
    const result = classifyIntent('please git commit this branch')
    expect(result.agent).toBe('opencode')
    expect(['keyword', 'topic']).toContain(result.triggeredBy)
    expect(result.score).toBeGreaterThan(0)
  })

  it('routes review/explain messages to claude-code', () => {
    const result = classifyIntent('please review this design and explain the tradeoffs')
    expect(result.agent).toBe('claude-code')
  })

  it('respects sticky session bias when message is generic', () => {
    const result = classifyIntent('thanks', 'codex')
    expect(result.agent).toBe('codex')
    expect(result.triggeredBy).toBe('sticky')
  })

  it('skips agents with an open circuit breaker', () => {
    // Open opencode
    for (let i = 0; i < 3; i++) circuitBreaker.recordFailure('opencode')
    const result = classifyIntent('git commit and push to main')
    expect(result.agent).not.toBe('opencode')
  })

  it('rounds the score to two decimals', () => {
    const result = classifyIntent('refactor this code please')
    expect(Number.isInteger(result.score * 100) || Math.abs(result.score * 100 - Math.round(result.score * 100)) < 1e-9).toBe(true)
  })

  it('returns a non-empty reason string', () => {
    const result = classifyIntent('refactor this typescript code')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})
