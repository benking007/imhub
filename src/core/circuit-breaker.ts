// Circuit breaker for agent invocations
//
// Tracks consecutive failures per agent. State machine:
//   closed   → recordFailure ≥ threshold → open
//   open     → cooldown elapsed         → half-open (1 trial slot)
//   half-open → recordSuccess           → closed (failures reset)
//   half-open → recordFailure           → open (cooldown × 2, capped)
//
// The half-open state is the meaningful upgrade over the previous design,
// which silently re-closed the breaker on cooldown — a cooldown elapsed
// AND the next request slipping through were both required for any signal,
// but if every request hammered through immediately the breaker only
// briefly hesitated. The new flow grants exactly one probe.

const DEFAULT_THRESHOLD = 3        // consecutive failures to open
const DEFAULT_COOLDOWN_MS = 300_000 // 5 minutes
const MAX_COOLDOWN_MS = 60 * 60_000 // 1 hour cap on exponential backoff

type BreakerPhase = 'closed' | 'open' | 'half-open'

interface BreakerState {
  phase: BreakerPhase
  failures: number
  openedAt: number | null
  /** Effective cooldown for this open cycle (doubles on repeated failures). */
  cooldownMs: number
}

class CircuitBreaker {
  private states = new Map<string, BreakerState>()
  private threshold: number
  private baseCooldownMs: number

  constructor(threshold = DEFAULT_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.threshold = threshold
    this.baseCooldownMs = cooldownMs
  }

  /** Record a failed invocation. Returns true if the breaker just opened. */
  recordFailure(agent: string): boolean {
    const s = this.get(agent)
    if (s.phase === 'half-open') {
      // Probe failed → re-open with double cooldown (capped).
      s.phase = 'open'
      s.openedAt = Date.now()
      s.cooldownMs = Math.min(s.cooldownMs * 2, MAX_COOLDOWN_MS)
      // failures count is preserved as a quality signal for /router status
      return true
    }
    s.failures++
    if (s.failures >= this.threshold && s.phase === 'closed') {
      s.phase = 'open'
      s.openedAt = Date.now()
      s.cooldownMs = this.baseCooldownMs
      return true
    }
    return false
  }

  /** Record a successful invocation. Closes the breaker, resets counters. */
  recordSuccess(agent: string): void {
    this.states.delete(agent)
  }

  /**
   * Check if an agent is currently blocked (breaker open AND cooldown still
   * active). After cooldown elapses we transition to half-open and *return
   * false for the first caller only* — that caller becomes the probe.
   */
  isOpen(agent: string): boolean {
    const s = this.states.get(agent)
    if (!s || s.phase === 'closed') return false
    if (s.phase === 'half-open') {
      // Probe slot already granted — block everyone else until the probe
      // returns success or failure.
      return true
    }
    // phase === 'open'
    if (s.openedAt !== null && Date.now() - s.openedAt > s.cooldownMs) {
      // Cooldown elapsed → grant a single probe. Return false (allow) for
      // this caller, but flip phase so concurrent callers see open.
      s.phase = 'half-open'
      return false
    }
    return true
  }

  /** Get status for display / debug. */
  getStatus(agent: string): { failures: number; open: boolean; phase: BreakerPhase; openedAt: number | null; cooldownMs: number } {
    const s = this.get(agent)
    return {
      failures: s.failures,
      open: s.phase !== 'closed',
      phase: s.phase,
      openedAt: s.openedAt,
      cooldownMs: s.cooldownMs,
    }
  }

  /** List all agents currently blocked (open or half-open with active probe). */
  listOpen(): string[] {
    const open: string[] = []
    for (const [agent, s] of this.states) {
      if (s.phase === 'open' || s.phase === 'half-open') open.push(agent)
    }
    return open
  }

  /**
   * Manually clear breaker state. Pass an agent name to reset just that
   * one, or no argument to reset everything. Useful for an operator
   * `/router reset <agent>` command.
   */
  reset(agent?: string): void {
    if (agent === undefined) {
      this.states.clear()
    } else {
      this.states.delete(agent)
    }
  }

  private get(agent: string): BreakerState {
    let s = this.states.get(agent)
    if (!s) {
      s = { phase: 'closed', failures: 0, openedAt: null, cooldownMs: this.baseCooldownMs }
      this.states.set(agent, s)
    }
    return s
  }
}

export const circuitBreaker = new CircuitBreaker()
