// Tests for job-board concurrency limit (P1-E).
//
// Under bun, better-sqlite3 isn't loadable so getJob() / createJob() use
// the fail-soft path. We sidestep that by stubbing getJob to return a
// fake row and by directly reaching into the runJob() pipeline. The
// concurrency gate (acquireSlot / releaseSlot) is independent of SQLite,
// so it is exercised here even when the underlying DB is degraded.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as jobBoard from '../../src/core/job-board'
import { logger as rootLogger } from '../../src/core/logger'
import type { Logger } from 'pino'

const logger: Logger = rootLogger

const ORIG_LIMIT = process.env.IM_HUB_MAX_CONCURRENT_JOBS

describe('Job Board concurrency cap', () => {
  beforeEach(() => {
    process.env.IM_HUB_MAX_CONCURRENT_JOBS = '2'
  })
  afterEach(() => {
    if (ORIG_LIMIT === undefined) delete process.env.IM_HUB_MAX_CONCURRENT_JOBS
    else process.env.IM_HUB_MAX_CONCURRENT_JOBS = ORIG_LIMIT
  })

  it('exposes diagnostics and never throws on stub callers', () => {
    expect(typeof jobBoard._activeJobCount()).toBe('number')
    expect(typeof jobBoard._waitQueueDepth()).toBe('number')
  })

  it('caps concurrent slot holders at IM_HUB_MAX_CONCURRENT_JOBS', async () => {
    // Exercise the concurrency gate directly so the test is independent
    // of better-sqlite3 (not loadable under bun). With max=2:
    //   - first two acquires resolve immediately
    //   - third parks on the wait queue
    //   - releasing one drains the queued caller
    const slot = jobBoard._testSlot
    await slot.acquire()
    await slot.acquire()
    expect(jobBoard._activeJobCount()).toBe(2)

    let thirdEntered = false
    const third = (async () => {
      await slot.acquire()
      thirdEntered = true
    })()

    await new Promise((r) => setTimeout(r, 20))
    // Third call must still be parked.
    expect(thirdEntered).toBe(false)
    expect(jobBoard._waitQueueDepth()).toBe(1)

    // Free a slot — third should now resolve.
    slot.release()
    await third
    expect(thirdEntered).toBe(true)
    expect(jobBoard._activeJobCount()).toBe(2)
    expect(jobBoard._waitQueueDepth()).toBe(0)

    // Drain the rest so we don't leak slot state into other tests.
    slot.release()
    slot.release()
    expect(jobBoard._activeJobCount()).toBe(0)
  })
})
