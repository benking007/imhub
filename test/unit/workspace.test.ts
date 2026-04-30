// Unit tests for the multi-tenant workspace registry

import { describe, it, expect } from 'bun:test'
import { Workspace, WorkspaceRegistry } from '../../src/core/workspace'

describe('Workspace', () => {
  it('with empty whitelist allows any agent', () => {
    const ws = new Workspace({ id: 'free', name: 'Free', agents: [] })
    expect(ws.hasAgent('claude-code')).toBe(true)
    expect(ws.hasAgent('any-custom-agent')).toBe(true)
  })

  it('with non-empty whitelist enforces membership', () => {
    const ws = new Workspace({ id: 'p', name: 'P', agents: ['opencode', 'claude-code'] })
    expect(ws.hasAgent('opencode')).toBe(true)
    expect(ws.hasAgent('codex')).toBe(false)
  })

  it('open workspace (no members) accepts any user', () => {
    const ws = new Workspace({ id: 'open', name: 'Open', agents: [] })
    expect(ws.hasMember('alice')).toBe(true)
    expect(ws.hasMember('bob')).toBe(true)
  })

  it('membered workspace enforces userId list', () => {
    const ws = new Workspace({
      id: 'team', name: 'Team', agents: [], members: ['alice', 'bob'],
    })
    expect(ws.hasMember('alice')).toBe(true)
    expect(ws.hasMember('mallory')).toBe(false)
  })

  it('honors per-workspace rate-limit settings', () => {
    const ws = new Workspace({
      id: 'tight', name: 'Tight', agents: [],
      rateLimit: { rate: 1, intervalSec: 60, burst: 1 },
    })
    expect(ws.allow('u')).toBe(true)
    expect(ws.allow('u')).toBe(false)
  })
})

describe('WorkspaceRegistry', () => {
  it('default workspace is unrestricted (empty whitelist allows all)', () => {
    const r = new WorkspaceRegistry()
    expect(r.default.hasAgent('claude-code')).toBe(true)
    expect(r.default.hasAgent('newly-registered-acp-agent')).toBe(true)
  })

  it('resolves to a named workspace when user is a member', () => {
    const r = new WorkspaceRegistry()
    r.add({ id: 'team', name: 'Team', agents: ['opencode'], members: ['alice'] })
    const ws = r.resolve('alice')
    expect(ws.id).toBe('team')
  })

  it('falls back to default for users with no membered workspace', () => {
    const r = new WorkspaceRegistry()
    r.add({ id: 'team', name: 'Team', agents: ['opencode'], members: ['alice'] })
    expect(r.resolve('mallory').id).toBe('default')
  })

  it('load() ingests workspace configs from a config object', () => {
    const r = new WorkspaceRegistry()
    r.load({
      workspaces: [
        { id: 'a', name: 'A', agents: ['opencode'] },
        { id: 'b', name: 'B', agents: ['claude-code'] },
      ],
    })
    expect(r.get('a')?.hasAgent('opencode')).toBe(true)
    expect(r.get('b')?.hasAgent('claude-code')).toBe(true)
  })

  it('does not crash on load() without workspaces field', () => {
    const r = new WorkspaceRegistry()
    r.load({})
    expect(r.default).toBeDefined()
  })
})
