// Unit tests for the per-agent circuit breaker

import { describe, it, expect } from 'bun:test'

// Use a fresh class per test to avoid the global singleton's hidden state.
import { circuitBreaker as globalBreaker } from '../../src/core/circuit-breaker'

// We re-import the file to access the underlying class via prototype hop.
// The module exposes only the singleton; tests build new instances via the
// singleton's constructor (`Object.getPrototypeOf` → `constructor`).
const Breaker: new (threshold?: number, cooldownMs?: number) => typeof globalBreaker =
  Object.getPrototypeOf(globalBreaker).constructor

describe('CircuitBreaker', () => {
  it('stays closed under threshold', () => {
    const br = new Breaker(3, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(false)
  })

  it('opens at threshold and lists open agents', () => {
    const br = new Breaker(3, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    const justOpened = br.recordFailure('a')
    expect(justOpened).toBe(true)
    expect(br.isOpen('a')).toBe(true)
    expect(br.listOpen()).toEqual(['a'])
  })

  it('does not re-open on subsequent failures while open', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    expect(br.recordFailure('a')).toBe(true)
    // already open: subsequent failure must not return true again
    expect(br.recordFailure('a')).toBe(false)
  })

  it('half-opens after the cooldown elapses', async () => {
    const br = new Breaker(2, 30)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    // cooldown elapsed → reported closed (half-open)
    expect(br.isOpen('a')).toBe(false)
    const status = br.getStatus('a')
    expect(status.failures).toBe(0)
    expect(status.open).toBe(false)
  })

  it('recordSuccess immediately closes', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    br.recordSuccess('a')
    expect(br.isOpen('a')).toBe(false)
    expect(br.listOpen()).toEqual([])
  })

  it('isolates agents independently', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    expect(br.isOpen('b')).toBe(false)
  })
})
