// Unit tests for the minimal cron parser (P2-F)

import { describe, it, expect } from 'bun:test'
import { parseCron, nextOccurrence } from '../../src/core/cron'

describe('parseCron', () => {
  it('accepts "* * * * *"', () => {
    const spec = parseCron('* * * * *')
    expect(spec.minute.values.size).toBe(60)
    expect(spec.hour.values.size).toBe(24)
    expect(spec.day.values.size).toBe(31)
    expect(spec.month.values.size).toBe(12)
    expect(spec.dow.values.size).toBe(7)
  })

  it('accepts single integers', () => {
    const spec = parseCron('5 17 * * *')
    expect([...spec.minute.values]).toEqual([5])
    expect([...spec.hour.values]).toEqual([17])
  })

  it('accepts comma lists', () => {
    const spec = parseCron('0,15,30,45 * * * *')
    expect([...spec.minute.values]).toEqual([0, 15, 30, 45])
  })

  it('accepts ranges', () => {
    const spec = parseCron('* 9-17 * * *')
    expect([...spec.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('accepts steps', () => {
    const spec = parseCron('*/15 * * * *')
    expect([...spec.minute.values]).toEqual([0, 15, 30, 45])
  })

  it('accepts stepped ranges', () => {
    const spec = parseCron('0-30/10 * * * *')
    expect([...spec.minute.values]).toEqual([0, 10, 20, 30])
  })

  it('normalizes dow=7 to Sunday=0', () => {
    const spec = parseCron('* * * * 7')
    expect([...spec.dow.values]).toEqual([0])
  })

  it('rejects bad field count', () => {
    expect(() => parseCron('* * * *')).toThrow('Expected 5 fields')
  })

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute/)
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/)
    expect(() => parseCron('* * 32 * *')).toThrow(/day/)
    expect(() => parseCron('* * * 13 *')).toThrow(/month/)
  })

  it('rejects step ≤ 0', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/i)
  })
})

describe('nextOccurrence', () => {
  it('every-minute fires the next minute', () => {
    const spec = parseCron('* * * * *')
    const from = new Date('2026-04-30T12:00:30.500Z')
    const next = nextOccurrence(spec, from)!
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getSeconds()).toBe(0)
    expect(next.getMilliseconds()).toBe(0)
  })

  it('hourly at minute 0', () => {
    const spec = parseCron('0 * * * *')
    const from = new Date('2026-04-30T12:00:30.000Z')
    const next = nextOccurrence(spec, from)!
    expect(next.getMinutes()).toBe(0)
    // Next firing is at least the next hour boundary
    expect(next.getTime() - from.getTime()).toBeGreaterThan(0)
  })

  it('weekday only (1-5) skips weekends', () => {
    const spec = parseCron('0 9 * * 1-5')
    // Use a Saturday
    const sat = new Date('2026-05-02T08:00:00.000Z')
    sat.setHours(8) // ensure local Saturday morning
    const next = nextOccurrence(spec, sat)!
    // Day-of-week of next must be Mon..Fri
    const dow = next.getDay()
    expect(dow).toBeGreaterThanOrEqual(1)
    expect(dow).toBeLessThanOrEqual(5)
  })

  it('"day OR dow" matches when both restricted', () => {
    // 1st of every month OR every Friday — use 2026-04-01 (Wed) as start.
    // Wed 1 should match (day=1).
    const spec = parseCron('0 0 1 * 5')
    const from = new Date('2026-04-30T23:59:00')
    const next = nextOccurrence(spec, from)!
    // Either day-1 or Friday in May 2026 — 2026-05-01 is a Friday and the
    // 1st, so we just check next is in May.
    expect(next.getMonth()).toBe(4)  // May (0-indexed)
  })
})
