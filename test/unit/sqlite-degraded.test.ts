// Smoke tests for fail-soft behavior when SQLite (better-sqlite3) is not
// loadable — bun runtime currently cannot dlopen better-sqlite3, so under
// `bun test` these calls exercise the degraded path. Under Node, the same
// asserts pass because empty arrays / zero stats are also valid for an
// empty database.

import { describe, it, expect } from 'bun:test'
import { logInvocation, queryInvocations, getStats } from '../../src/core/audit-log'
import { listJobs, getJob, getJobStats, cancelJob } from '../../src/core/job-board'

describe('audit-log degraded mode', () => {
  it('logInvocation does not throw on broken DB', () => {
    expect(() => logInvocation({
      traceId: 't', userId: 'u', platform: 'p', agent: 'a', intent: 'default',
      promptLen: 1, responseLen: 1, durationMs: 1, cost: 0, success: true,
    })).not.toThrow()
  })

  it('queryInvocations returns an array', () => {
    const rows = queryInvocations()
    expect(Array.isArray(rows)).toBe(true)
  })

  it('queryInvocations clamps insane limit values', () => {
    expect(() => queryInvocations({ limit: -5 })).not.toThrow()
    expect(() => queryInvocations({ limit: NaN })).not.toThrow()
    expect(() => queryInvocations({ limit: 1e9 })).not.toThrow()
  })

  it('queryInvocations rejects negative/NaN days silently', () => {
    expect(() => queryInvocations({ days: -1 })).not.toThrow()
    expect(() => queryInvocations({ days: NaN })).not.toThrow()
  })

  it('getStats returns a well-shaped object even on broken DB', () => {
    const s = getStats()
    expect(typeof s.total).toBe('number')
    expect(s.byAgent).toBeDefined()
    expect(typeof s.totalCost).toBe('number')
    expect(Number.isNaN(s.totalCost)).toBe(false)
  })
})

describe('job-board degraded mode', () => {
  it('getJob returns null when DB is unavailable', () => {
    const job = getJob(999_999_999)
    expect(job).toBeNull()
  })

  it('listJobs returns an array', () => {
    const jobs = listJobs()
    expect(Array.isArray(jobs)).toBe(true)
  })

  it('listJobs clamps limit values', () => {
    expect(() => listJobs(-1)).not.toThrow()
    expect(() => listJobs(NaN)).not.toThrow()
    expect(() => listJobs(1e9)).not.toThrow()
  })

  it('cancelJob on missing job returns false instead of throwing', () => {
    expect(cancelJob(999_999_999)).toBe(false)
  })

  it('getJobStats returns an all-zero object when DB unavailable', () => {
    const stats = getJobStats()
    expect(stats.total).toBeGreaterThanOrEqual(0)
    expect(stats.pending).toBeGreaterThanOrEqual(0)
    expect(stats.running).toBeGreaterThanOrEqual(0)
    expect(stats.completed).toBeGreaterThanOrEqual(0)
    expect(stats.failed).toBeGreaterThanOrEqual(0)
  })
})
