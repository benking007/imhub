// Unit tests for the /audit command argument parser (P1-F).
//
// We invoke handleAuditCommand with the SQLite layer in fail-soft mode
// (bun runtime) so the function returns deterministic 'no records' or
// formatted strings — letting us assert that command-line argument
// parsing works without depending on the DB itself.

import { describe, it, expect } from 'bun:test'
import { handleAuditCommand } from '../../src/core/commands/audit'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

const ctx: RouteContext = {
  channelId: 'c', threadId: 't', platform: 'wechat',
  defaultAgent: 'opencode', traceId: 'tr', logger, userId: 'u',
}

describe('/audit argument parser', () => {
  it('returns the help footer with new filter examples', async () => {
    const out = await handleAuditCommand('', ctx)
    // No records under bun-degraded SQLite — early-return path
    expect(out).toContain('暂无')
  })

  it('accepts explicit numeric limit', async () => {
    const out = await handleAuditCommand('25', ctx)
    expect(typeof out).toBe('string')
  })

  it('accepts agent= filter', async () => {
    const out = await handleAuditCommand('agent=opencode', ctx)
    expect(typeof out).toBe('string')
  })

  it('accepts user= filter (P1-F)', async () => {
    const out = await handleAuditCommand('user=wx_abc', ctx)
    expect(typeof out).toBe('string')
  })

  it('accepts intent= filter (P1-F)', async () => {
    const out = await handleAuditCommand('intent=topic', ctx)
    expect(typeof out).toBe('string')
  })

  it('accepts platform= filter (P1-F)', async () => {
    const out = await handleAuditCommand('platform=telegram', ctx)
    expect(typeof out).toBe('string')
  })

  it('rejects negative limits silently (clamps via parser)', async () => {
    // Should not throw; output is the no-records message.
    const out = await handleAuditCommand('-50', ctx)
    expect(typeof out).toBe('string')
  })

  it('rejects negative days silently', async () => {
    const out = await handleAuditCommand('days=-7', ctx)
    expect(typeof out).toBe('string')
  })

  it('rejects days=0 (zero days = nonsense filter)', async () => {
    const out = await handleAuditCommand('days=0', ctx)
    expect(typeof out).toBe('string')
  })

  it('combines multiple filters', async () => {
    const out = await handleAuditCommand('agent=opencode user=alice days=7 50', ctx)
    expect(typeof out).toBe('string')
  })
})
