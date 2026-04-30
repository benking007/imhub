// Unit tests for the per-user/agent token-bucket rate limiter

import { describe, it, expect } from 'bun:test'
import { RateLimiter } from '../../src/core/rate-limiter'

describe('RateLimiter', () => {
  it('starts at full burst capacity', () => {
    const rl = new RateLimiter(10, 60_000, 5)
    expect(rl.remaining('user-a')).toBe(5)
  })

  it('decrements per allowed request and rejects when exhausted', () => {
    const rl = new RateLimiter(10, 60_000, 3)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(false)
    expect(rl.remaining('u')).toBe(0)
  })

  it('isolates buckets per key', () => {
    const rl = new RateLimiter(10, 60_000, 1)
    expect(rl.allow('alice')).toBe(true)
    expect(rl.allow('alice')).toBe(false)
    // bob gets his own bucket
    expect(rl.allow('bob')).toBe(true)
  })

  it('refills tokens after a full interval elapses', async () => {
    const rl = new RateLimiter(2, 50, 2)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(rl.allow('u')).toBe(true)
  })

  it('does not exceed burst on long idle (refill is clamped)', async () => {
    const rl = new RateLimiter(10, 20, 5)
    rl.allow('u') // burn one to force a bucket entry
    await new Promise((r) => setTimeout(r, 200))
    // After 10 intervals, theoretical refill would be 100 tokens; clamped to burst.
    expect(rl.remaining('u')).toBeLessThanOrEqual(5)
  })

  it('status() reports configured rate and interval', () => {
    const rl = new RateLimiter(7, 30_000, 9)
    const s = rl.status('u')
    expect(s.rate).toBe(7)
    expect(s.intervalSec).toBe(30)
    expect(s.remaining).toBe(9)
  })
})
