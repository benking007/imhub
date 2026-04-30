// Unit tests for /model — verifies agent-scoped behavior, persistence,
// and #N index lookup using the same SessionManager key as the runtime.

import { describe, it, expect } from 'bun:test'
import { handleModelCommand } from '../../src/core/commands/model'
import { sessionManager } from '../../src/core/session'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

function makeCtx(suffix: string, agent = 'opencode'): RouteContext {
  const id = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    platform: 'test', channelId: 'ch-' + id, threadId: 't-' + id,
    defaultAgent: agent, traceId: 'tr', logger: noopLogger, userId: 'u',
  }
}

describe('/model', () => {
  it('refuses on non-opencode agent with friendly message', async () => {
    const ctx = makeCtx('model-cc', 'claude-code')
    // Pre-create a session pinned to claude-code so handleModelCommand sees it
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'claude-code')
    const out = await handleModelCommand('', ctx)
    expect(out).toContain('仅在')
    expect(out).toContain('opencode')
  })

  it('rejects /model #N before /models has run', async () => {
    const ctx = makeCtx('model-noidx')
    const out = await handleModelCommand('#3', ctx)
    expect(out).toContain('没有缓存')
  })

  it('rejects bare short names without a slash', async () => {
    const ctx = makeCtx('model-short')
    const out = await handleModelCommand('gpt-4', ctx)
    expect(out).toContain('provider/model')
  })

  it('refresh subcommand returns success even with no cache', async () => {
    const ctx = makeCtx('model-refresh')
    const out = await handleModelCommand('refresh', ctx)
    expect(out).toContain('已清空')
  })
})
