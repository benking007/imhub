// Unit tests for in-process metrics (P2-A)

import { describe, it, expect, beforeEach } from 'bun:test'
import { recordInvocation, snapshot, toPrometheus, reset } from '../../src/core/metrics'

describe('metrics', () => {
  beforeEach(() => { reset() })

  it('records invocations and counts success/failure', () => {
    recordInvocation({ agent: 'opencode', intent: 'topic', platform: 'wechat', durationMs: 100, cost: 0.01, success: true })
    recordInvocation({ agent: 'opencode', intent: 'topic', platform: 'wechat', durationMs: 200, cost: 0.02, success: true })
    recordInvocation({ agent: 'opencode', intent: 'fallback', platform: 'wechat', durationMs: 500, cost: 0, success: false })

    const snap = snapshot()
    const oc = snap.agents.find((a) => a.agent === 'opencode')
    expect(oc).toBeDefined()
    expect(oc!.total).toBe(3)
    expect(oc!.success).toBe(2)
    expect(oc!.failure).toBe(1)
    expect(oc!.successRate).toBeCloseTo(2 / 3, 5)
    expect(oc!.costSum).toBeCloseTo(0.03, 5)
  })

  it('computes p50/p95/p99 latency quantiles', () => {
    for (let i = 1; i <= 100; i++) {
      recordInvocation({ agent: 'a', intent: 'd', platform: 'p', durationMs: i, cost: 0, success: true })
    }
    const a = snapshot().agents.find((x) => x.agent === 'a')!
    expect(a.p50Ms).toBeGreaterThanOrEqual(45)
    expect(a.p50Ms).toBeLessThanOrEqual(55)
    expect(a.p95Ms).toBeGreaterThanOrEqual(90)
    expect(a.p99Ms).toBeGreaterThanOrEqual(95)
  })

  it('keeps the sliding window bounded', () => {
    for (let i = 0; i < 5000; i++) {
      recordInvocation({ agent: 'b', intent: 'd', platform: 'p', durationMs: i, cost: 0, success: true })
    }
    const b = snapshot().agents.find((x) => x.agent === 'b')!
    // Default cap is 1024 — sliding window must stop growing past that
    expect(b.sampleCount).toBeLessThanOrEqual(1024)
    expect(b.total).toBe(5000)  // total counter is still cumulative
  })

  it('groups intent and platform totals', () => {
    recordInvocation({ agent: 'a', intent: 'topic', platform: 'wechat', durationMs: 1, cost: 0, success: true })
    recordInvocation({ agent: 'a', intent: 'sticky', platform: 'wechat', durationMs: 1, cost: 0, success: true })
    recordInvocation({ agent: 'a', intent: 'topic', platform: 'telegram', durationMs: 1, cost: 0, success: true })

    const snap = snapshot()
    expect(snap.intentTotals.topic).toBe(2)
    expect(snap.intentTotals.sticky).toBe(1)
    expect(snap.platformTotals.wechat).toBe(2)
    expect(snap.platformTotals.telegram).toBe(1)
  })

  it('emits Prometheus text exposition format', () => {
    recordInvocation({ agent: 'opencode', intent: 'topic', platform: 'wechat', durationMs: 100, cost: 0.01, success: true })
    const text = toPrometheus()

    // Required Prom features: HELP/TYPE preambles + label-quoted samples
    expect(text).toContain('# HELP im_hub_uptime_seconds')
    expect(text).toContain('# TYPE im_hub_agent_invocations_total counter')
    expect(text).toMatch(/im_hub_agent_invocations_total\{agent="opencode",result="success"\} \d+/)
    expect(text).toMatch(/im_hub_agent_latency_ms\{agent="opencode",quantile="0\.95"\} \d+/)
    expect(text).toMatch(/im_hub_intent_total\{intent="topic"\} \d+/)
    expect(text).toMatch(/im_hub_platform_total\{platform="wechat"\} \d+/)
  })

  it('escapes label values with double quotes / newlines', () => {
    recordInvocation({ agent: 'weird"name', intent: 'a', platform: 'p', durationMs: 1, cost: 0, success: true })
    const text = toPrometheus()
    expect(text).toContain('agent="weird\\"name"')
  })

  it('rejects non-finite duration values silently', () => {
    expect(() => {
      recordInvocation({ agent: 'a', intent: 'd', platform: 'p', durationMs: NaN, cost: 0, success: true })
    }).not.toThrow()
    const a = snapshot().agents.find((x) => x.agent === 'a')!
    expect(a.sampleCount).toBe(0)
    expect(a.total).toBe(1)  // counter still increments
  })

  it('quantile via quickselect matches sort-based reference', () => {
    // Stress with random durations to verify quickselect picks the same
    // value the old sort-based path would have.
    const samples: number[] = []
    for (let i = 0; i < 500; i++) {
      const v = Math.floor(Math.random() * 1_000_000)
      samples.push(v)
      recordInvocation({ agent: 'rand', intent: 'd', platform: 'p', durationMs: v, cost: 0, success: true })
    }
    const sorted = samples.slice().sort((a, b) => a - b)
    const refIdx = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]

    const a = snapshot().agents.find((x) => x.agent === 'rand')!
    expect(a.p50Ms).toBe(refIdx(0.5))
    expect(a.p95Ms).toBe(refIdx(0.95))
    expect(a.p99Ms).toBe(refIdx(0.99))
  })
})
