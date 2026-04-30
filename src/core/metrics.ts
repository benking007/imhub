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

  /** Copy the current sample set (unsorted). */
  snapshot(): number[] {
    const len = this.full ? this.buf.length : this.idx
    return this.buf.slice(0, len)
  }

  size(): number {
    return this.full ? this.buf.length : this.idx
  }
}

/**
 * Hoare-style partition. Returns an index `p` such that everything in
 * [lo, p] is ≤ pivot and everything in [p+1, hi] is ≥ pivot.
 */
function partition(arr: number[], lo: number, hi: number): number {
  const pivot = arr[(lo + hi) >>> 1]
  let i = lo - 1, j = hi + 1
  while (true) {
    do { i++ } while (arr[i] < pivot)
    do { j-- } while (arr[j] > pivot)
    if (i >= j) return j
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp
  }
}

/**
 * In-place quickselect: after the call, arr[k] is the value that would
 * be at index k in a fully-sorted array. Average O(n).
 */
function quickselect(arr: number[], k: number, lo: number, hi: number): void {
  while (lo < hi) {
    const p = partition(arr, lo, hi)
    if (k <= p) hi = p
    else lo = p + 1
  }
}

/**
 * Compute multiple quantiles in a single shared copy. Sorts the
 * quantiles ascending, then runs quickselect with each successive
 * `lo` bounded by the previous index — so we only re-partition the
 * tail relevant to the higher quantile.
 *
 * For 3 quantiles on n=1024 this is ~3n comparisons vs n·log(n) ≈ 10n
 * for a full sort.
 */
function multiQuantile(buf: number[], qs: number[]): number[] {
  if (buf.length === 0) return qs.map(() => 0)
  const arr = buf.slice()
  const n = arr.length
  const ordered = qs.map((q, i) => ({
    q,
    i,
    idx: Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1)))),
  }))
  ordered.sort((a, b) => a.idx - b.idx)

  const out = new Array<number>(qs.length)
  let lo = 0
  for (const { i, idx } of ordered) {
    quickselect(arr, idx, lo, n - 1)
    out[i] = arr[idx]
    lo = idx  // next quantile is at or after this one
  }
  return out
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
    const samples = b.latency.snapshot()
    const [p50Ms, p95Ms, p99Ms] = multiQuantile(samples, [0.5, 0.95, 0.99])
    agents.push({
      agent,
      total: b.total,
      success: b.success,
      failure: b.failure,
      successRate: b.total > 0 ? b.success / b.total : 0,
      costSum: b.costSum,
      sampleCount: samples.length,
      p50Ms,
      p95Ms,
      p99Ms,
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
