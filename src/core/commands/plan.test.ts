// /plan command — toggle plan mode for the active session.
//
// Drives sessionManager via the real public API (writes hit
// ~/.im-hub/sessions disk-backed) but uses a unique platform tag so we can
// scrub our own files in afterEach without colliding with real sessions.

import { describe, it, expect, afterEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { unlink, readdir, readFile } from 'fs/promises'
import { sessionManager } from '../session.js'
import { handlePlanCommand } from './plan.js'
import type { RouteContext } from '../router.js'
import type { Logger } from 'pino'

const PLATFORM = 'plantest'
const SESSIONS_DIR = join(homedir(), '.im-hub', 'sessions')

function uid(): string { return Math.random().toString(36).slice(2, 10) }

async function cleanupTestSessions(): Promise<void> {
  let names: string[]
  try { names = await readdir(SESSIONS_DIR) } catch { return }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(SESSIONS_DIR, name), 'utf-8')
      const parsed = JSON.parse(raw) as { platform?: string }
      if (parsed.platform === PLATFORM) {
        await unlink(join(SESSIONS_DIR, name)).catch(() => {})
        await unlink(join(SESSIONS_DIR, name.replace(/\.json$/, '.log'))).catch(() => {})
      }
    } catch { /* ignore */ }
  }
}

function makeCtx(channelId: string, threadId: string): RouteContext {
  return {
    channelId, threadId, platform: PLATFORM,
    defaultAgent: 'claude-code', traceId: 't',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) } as unknown as Logger,
  }
}

afterEach(async () => {
  delete process.env.IMHUB_DISABLE_PLAN_MODE
  await cleanupTestSessions()
})

describe('handlePlanCommand', () => {
  it('shows current state (off) and usage when invoked with no args on a fresh session', async () => {
    const ctx = makeCtx(uid(), uid())
    // Pre-create the session so the status query has something to read.
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'claude-code')
    const out = await handlePlanCommand('', ctx)
    expect(out).toContain('Plan 模式')
    expect(out).toContain('off')
    expect(out).toContain('/plan on')
    expect(out).toContain('/plan off')
  })

  it('/plan on flips planMode true and persists it', async () => {
    const ctx = makeCtx(uid(), uid())
    const out = await handlePlanCommand('on', ctx)
    expect(out).toContain('已开启')
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBe(true)
  })

  it('/plan off clears planMode', async () => {
    const ctx = makeCtx(uid(), uid())
    await handlePlanCommand('on', ctx)
    const out = await handlePlanCommand('off', ctx)
    expect(out).toContain('已关闭')
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBeUndefined()
  })

  it('/plan on twice is idempotent (no error, friendly message)', async () => {
    const ctx = makeCtx(uid(), uid())
    await handlePlanCommand('on', ctx)
    const out = await handlePlanCommand('on', ctx)
    expect(out).toContain('无变化')
  })

  it('/plan off when already off says so without churning', async () => {
    const ctx = makeCtx(uid(), uid())
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'claude-code')
    const out = await handlePlanCommand('off', ctx)
    expect(out).toContain('本来就是关闭')
  })

  it('rejects unknown subcommands with usage hint', async () => {
    const ctx = makeCtx(uid(), uid())
    const out = await handlePlanCommand('maybe', ctx)
    expect(out).toContain('无效参数')
    expect(out).toContain('on')
    expect(out).toContain('off')
  })

  it('honours alias tokens (enter / exit)', async () => {
    const ctx = makeCtx(uid(), uid())
    await handlePlanCommand('enter', ctx)
    let session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBe(true)
    await handlePlanCommand('exit', ctx)
    session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBeUndefined()
  })

  it('honours Chinese alias tokens (开/关)', async () => {
    const ctx = makeCtx(uid(), uid())
    await handlePlanCommand('开', ctx)
    let session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBe(true)
    await handlePlanCommand('关', ctx)
    session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBeUndefined()
  })

  it('IMHUB_DISABLE_PLAN_MODE=1 short-circuits without touching session state', async () => {
    const ctx = makeCtx(uid(), uid())
    process.env.IMHUB_DISABLE_PLAN_MODE = '1'
    const out = await handlePlanCommand('on', ctx)
    expect(out).toContain('已通过')
    expect(out).toContain('禁用')
    // No session should have been created or mutated.
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.planMode).toBeUndefined()
  })
})
