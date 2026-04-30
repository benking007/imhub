// Tests for the /workspaces slash command (P2-G)

import { describe, it, expect, beforeEach } from 'bun:test'
import { handleWorkspacesCommand } from '../../src/core/commands/workspaces'
import { workspaceRegistry } from '../../src/core/workspace'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger

function makeCtx(userId = 'tester'): RouteContext {
  return {
    channelId: 'c', threadId: 't', platform: 'wechat',
    defaultAgent: 'opencode', traceId: 'tr', logger, userId,
  }
}

describe('/workspaces', () => {
  beforeEach(() => {
    // Add a deterministic named workspace for assertions.
    workspaceRegistry.add({
      id: 'ws-cmd-test',
      name: 'Command Test',
      agents: ['opencode'],
      members: ['ws-tester'],
      rateLimit: { rate: 5, intervalSec: 60, burst: 7 },
    })
  })

  it('list shows the default workspace + named ones', async () => {
    const out = await handleWorkspacesCommand('list', makeCtx())
    expect(out).toContain('Workspaces')
    expect(out).toContain('default')
    expect(out).toContain('ws-cmd-test')
  })

  it('list marks the resolving workspace with ← you', async () => {
    const out = await handleWorkspacesCommand('list', makeCtx('ws-tester'))
    expect(out).toContain('ws-cmd-test')
    expect(out).toContain('← you')
  })

  it('show <id> details an explicit workspace', async () => {
    const out = await handleWorkspacesCommand('show ws-cmd-test', makeCtx())
    expect(out).toContain('Command Test')
    expect(out).toContain('opencode')
    expect(out).toContain('5 req / 60s')
  })

  it('show <unknown> returns a not-found error', async () => {
    const out = await handleWorkspacesCommand('show nope', makeCtx())
    expect(out).toContain('not found')
  })

  it('whoami reports the current user\'s workspace', async () => {
    const out = await handleWorkspacesCommand('whoami', makeCtx('ws-tester'))
    expect(out).toContain('ws-tester')
    expect(out).toContain('ws-cmd-test')
    expect(out).toContain('opencode')
  })

  it('whoami for non-member falls back to default', async () => {
    const out = await handleWorkspacesCommand('whoami', makeCtx('random-user'))
    expect(out).toContain('default')
    expect(out).toContain('unrestricted')
  })

  it('unknown subcommand prints usage', async () => {
    const out = await handleWorkspacesCommand('weird', makeCtx())
    expect(out).toContain('用法')
  })
})

describe('workspaceRegistry.list()', () => {
  it('returns an array including the default workspace', () => {
    const all = workspaceRegistry.list()
    expect(all.some((w) => w.id === 'default')).toBe(true)
  })

  it('reports rateLimit config (rate, intervalSec, burst)', () => {
    const all = workspaceRegistry.list()
    for (const w of all) {
      expect(w.rateLimit.rate).toBeGreaterThan(0)
      expect(w.rateLimit.intervalSec).toBeGreaterThan(0)
      expect(w.rateLimit.burst).toBeGreaterThan(0)
    }
  })

  it('open workspace (no member list) reports members=null', () => {
    const def = workspaceRegistry.list().find((w) => w.id === 'default')!
    expect(def.members).toBeNull()
  })
})
