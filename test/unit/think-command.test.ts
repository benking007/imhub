// Unit tests for /think — verifies the variant value is persisted via
// sessionManager.patchSession (not just mutated in-memory).

import { describe, it, expect, beforeEach } from 'bun:test'
import { handleThinkCommand } from '../../src/core/commands/think'
import { sessionManager } from '../../src/core/session'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

function makeCtx(suffix: string): RouteContext {
  const id = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    platform: 'test', channelId: 'ch-' + id, threadId: 't-' + id,
    defaultAgent: 'opencode', traceId: 'tr', logger: noopLogger, userId: 'u',
  }
}

describe('/think', () => {
  it('reports auto when no session/variant set', async () => {
    const ctx = makeCtx('think-auto')
    const out = await handleThinkCommand('', ctx)
    expect(out).toContain('auto')
  })

  it('persists high → readable on next /think query', async () => {
    const ctx = makeCtx('think-persist')
    await handleThinkCommand('high', ctx)
    const out = await handleThinkCommand('', ctx)
    expect(out).toContain('high')

    // Round-trip via sessionManager
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.variant).toBe('high')
  })

  it('off / none / auto clear the variant', async () => {
    const ctx = makeCtx('think-off')
    await handleThinkCommand('high', ctx)
    await handleThinkCommand('off', ctx)
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.variant).toBeFalsy()
  })

  it('rejects invalid level with usage hint', async () => {
    const ctx = makeCtx('think-bad')
    const out = await handleThinkCommand('lol', ctx)
    expect(out).toContain('无效值')
  })
})
