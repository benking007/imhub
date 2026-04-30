// Unit tests for /stats — verifies it reports the live usage roll-up
// fed by sessionManager.recordUsage().

import { describe, it, expect } from 'bun:test'
import { handleStatsCommand } from '../../src/core/commands/stats'
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

describe('/stats', () => {
  it('reports no active session when none exists', async () => {
    const ctx = makeCtx('stats-none')
    const out = await handleStatsCommand('', ctx)
    expect(out).toContain('没有活跃会话')
  })

  it('reports no AI calls when session has no usage yet', async () => {
    const ctx = makeCtx('stats-fresh')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'opencode')
    const out = await handleStatsCommand('', ctx)
    expect(out).toContain('尚未产生 AI 调用')
  })

  it('rolls up costUsd / turns / chars across multiple recordUsage calls', async () => {
    const ctx = makeCtx('stats-roll')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'opencode')

    await sessionManager.recordUsage(ctx.platform, ctx.channelId, ctx.threadId, {
      costUsd: 0.0123, promptChars: 100, responseChars: 200, durationMs: 1500,
    })
    await sessionManager.recordUsage(ctx.platform, ctx.channelId, ctx.threadId, {
      costUsd: 0.0077, promptChars: 50, responseChars: 75, durationMs: 800,
    })

    const out = await handleStatsCommand('', ctx)
    // turns=2, cost = 0.02
    expect(out).toContain('轮次**: 2')
    expect(out).toContain('$0.0200')
    expect(out).toMatch(/输入: 150/)
    expect(out).toMatch(/输出: 275/)
  })

  it('honors IM_HUB_USD_TO_CNY env override', async () => {
    const ctx = makeCtx('stats-fx')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'opencode')
    await sessionManager.recordUsage(ctx.platform, ctx.channelId, ctx.threadId, {
      costUsd: 1, promptChars: 1, responseChars: 1, durationMs: 1,
    })

    const orig = process.env.IM_HUB_USD_TO_CNY
    process.env.IM_HUB_USD_TO_CNY = '8.5'
    try {
      const out = await handleStatsCommand('', ctx)
      expect(out).toContain('¥8.50')
    } finally {
      if (orig === undefined) delete process.env.IM_HUB_USD_TO_CNY
      else process.env.IM_HUB_USD_TO_CNY = orig
    }
  })
})
