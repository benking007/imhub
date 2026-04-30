// Metrics — in-process counters + latency / cost histograms.
//
// Lightweight & dependency-free: a sliding sample ring per (agent, intent,
// success) bucket lets us compute p50/p95/p99 on demand. /api/metrics
// emits a Prometheus-compatible text body so scraping tools can ingest
// without us pulling in prom-client.
//
// This module is fed by audit-log.logInvocation (so every recorded request
// also updates metrics) — single source of truth, no duplicate observers.

const MAX_SAMPLES = 1024  // rolling window per metric label set

/**
 * Bounded sliding window. Append-only writes overwrite the oldest entry
 * once full, so memory is fixed regardless of traffic.
 */
class SlidingWindow {
  private buf: number[]
  private idx = 0
  private full = false

  constructor(capacity = MAX_SAMPLES) {
    this.buf = new Array(capacity)
  }

  push(v: number): void {
    this.buf[this.idx] = v
    this.idx = (this.idx + 1) % this.buf.length
    if (this.idx === 0) this.full = true
  }

  /** Materialize the current sample set, sorted ascending. */
  snapshot(): number[] {
    const len = this.full ? this.buf.length : this.idx
    const out = this.buf.slice(0, len)
    out.sort((a, b) => a - b)
    return out
  }

  size(): number {
    return this.full ? this.buf.length : this.idx
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))
  return sorted[idx]
}

interface AgentBucket {
  total: number
  success: number
  failure: number
  costSum: number
  latency: SlidingWindow
}

const agentBuckets = new Map<string, AgentBucket>()
const intentCounter = new Map<string, number>()
const platformCounter = new Map<string, number>()
const startedAt = Date.now()

function getBucket(agent: string): AgentBucket {
  let b = agentBuckets.get(agent)
  if (!b) {
    b = { total: 0, success: 0, failure: 0, costSum: 0, latency: new SlidingWindow() }
    agentBuckets.set(agent, b)
  }
  return b
}

export interface RecordedInvocation {
  agent: string
  intent: string
  platform: string
  durationMs: number
  cost: number
  success: boolean
}

export function recordInvocation(rec: RecordedInvocation): void {
  const b = getBucket(rec.agent)
  b.total++
  if (rec.success) b.success++
  else b.failure++
  b.costSum += rec.cost || 0
  if (Number.isFinite(rec.durationMs) && rec.durationMs >= 0) {
    b.latency.push(rec.durationMs)
  }
  intentCounter.set(rec.intent, (intentCounter.get(rec.intent) || 0) + 1)
  platformCounter.set(rec.platform, (platformCounter.get(rec.platform) || 0) + 1)
}

export interface MetricsSnapshot {
  uptimeSec: number
  agents: Array<{
    agent: string
    total: number
    success: number
    failure: number
    successRate: number
    costSum: number
    sampleCount: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
  }>
  intentTotals: Record<string, number>
  platformTotals: Record<string, number>
}

export function snapshot(): MetricsSnapshot {
  const now = Date.now()
  const agents: MetricsSnapshot['agents'] = []
  for (const [agent, b] of agentBuckets) {
    const sorted = b.latency.snapshot()
    agents.push({
      agent,
      total: b.total,
      success: b.success,
      failure: b.failure,
      successRate: b.total > 0 ? b.success / b.total : 0,
      costSum: b.costSum,
      sampleCount: sorted.length,
      p50Ms: quantile(sorted, 0.5),
      p95Ms: quantile(sorted, 0.95),
      p99Ms: quantile(sorted, 0.99),
    })
  }
  agents.sort((a, b) => a.agent.localeCompare(b.agent))
  return {
    uptimeSec: Math.round((now - startedAt) / 1000),
    agents,
    intentTotals: Object.fromEntries(intentCounter),
    platformTotals: Object.fromEntries(platformCounter),
  }
}

/**
 * Render the snapshot in Prometheus text exposition format. Keeps line
 * count low and uses bare metric names without a HELP/TYPE preamble per
 * line family (we emit one preamble each).
 */
export function toPrometheus(): string {
  const snap = snapshot()
  const lines: string[] = []
  lines.push('# HELP im_hub_uptime_seconds Process uptime in seconds')
  lines.push('# TYPE im_hub_uptime_seconds gauge')
  lines.push(`im_hub_uptime_seconds ${snap.uptimeSec}`)

  lines.push('# HELP im_hub_agent_invocations_total Total agent invocations')
  lines.push('# TYPE im_hub_agent_invocations_total counter')
  for (const a of snap.agents) {
    lines.push(`im_hub_agent_invocations_total{agent="${esc(a.agent)}",result="success"} ${a.success}`)
    lines.push(`im_hub_agent_invocations_total{agent="${esc(a.agent)}",result="failure"} ${a.failure}`)
  }

  lines.push('# HELP im_hub_agent_cost_sum Sum of recorded cost per agent')
  lines.push('# TYPE im_hub_agent_cost_sum counter')
  for (const a of snap.agents) {
    lines.push(`im_hub_agent_cost_sum{agent="${esc(a.agent)}"} ${a.costSum}`)
  }

  lines.push('# HELP im_hub_agent_latency_ms Latency quantiles (sliding window)')
  lines.push('# TYPE im_hub_agent_latency_ms summary')
  for (const a of snap.agents) {
    lines.push(`im_hub_agent_latency_ms{agent="${esc(a.agent)}",quantile="0.5"} ${a.p50Ms}`)
    lines.push(`im_hub_agent_latency_ms{agent="${esc(a.agent)}",quantile="0.95"} ${a.p95Ms}`)
    lines.push(`im_hub_agent_latency_ms{agent="${esc(a.agent)}",quantile="0.99"} ${a.p99Ms}`)
    lines.push(`im_hub_agent_latency_ms_count{agent="${esc(a.agent)}"} ${a.sampleCount}`)
  }

  lines.push('# HELP im_hub_intent_total Routing decisions by intent')
  lines.push('# TYPE im_hub_intent_total counter')
  for (const [intent, n] of Object.entries(snap.intentTotals)) {
    lines.push(`im_hub_intent_total{intent="${esc(intent)}"} ${n}`)
  }

  lines.push('# HELP im_hub_platform_total Requests by platform')
  lines.push('# TYPE im_hub_platform_total counter')
  for (const [platform, n] of Object.entries(snap.platformTotals)) {
    lines.push(`im_hub_platform_total{platform="${esc(platform)}"} ${n}`)
  }

  return lines.join('\n') + '\n'
}

/** Reset all counters. Test-only. */
export function reset(): void {
  agentBuckets.clear()
  intentCounter.clear()
  platformCounter.clear()
}

function esc(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
