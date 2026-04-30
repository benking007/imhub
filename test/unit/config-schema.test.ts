// Unit tests for zod-based config validation

import { describe, it, expect } from 'bun:test'
import { validateConfig } from '../../src/core/config-schema'

describe('validateConfig', () => {
  it('accepts an empty object and fills defaults', () => {
    const result = validateConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.messengers).toEqual([])
      expect(result.config.agents).toEqual([])
      expect(result.config.defaultAgent).toBe('claude-code')
    }
  })

  it('preserves passthrough fields', () => {
    const result = validateConfig({ defaultAgent: 'opencode', extraField: 42 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.defaultAgent).toBe('opencode')
      // passthrough() preserves unknown keys
      expect((result.config as Record<string, unknown>).extraField).toBe(42)
    }
  })

  it('rejects telegram config without botToken', () => {
    const result = validateConfig({ telegram: { channelId: 'xyz' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('telegram.botToken'))).toBe(true)
    }
  })

  it('rejects feishu config without secret', () => {
    const result = validateConfig({ feishu: { appId: 'app' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('feishu.appSecret'))).toBe(true)
    }
  })

  it('accepts a valid acpAgents entry', () => {
    const result = validateConfig({
      acpAgents: [{ name: 'my-agent', endpoint: 'https://example.com' }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects acpAgents with empty name or endpoint', () => {
    const result = validateConfig({
      acpAgents: [{ name: '', endpoint: '' }],
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a workspace config with rate limit', () => {
    const result = validateConfig({
      workspaces: [{
        id: 'team', agents: ['opencode'], members: ['alice'],
        rateLimit: { rate: 5, intervalSec: 60, burst: 10 },
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects negative rateLimit values', () => {
    const result = validateConfig({
      workspaces: [{
        id: 'team', agents: [],
        rateLimit: { rate: -1, intervalSec: 60, burst: 10 },
      }],
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer port numbers', () => {
    const result = validateConfig({ webPort: -10 })
    expect(result.ok).toBe(false)
  })

  it('returns structured error paths', () => {
    const result = validateConfig({ telegram: 'not-an-object' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('telegram')
    }
  })
})
