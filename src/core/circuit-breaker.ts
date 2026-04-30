// Circuit breaker for agent invocations
//
// Tracks consecutive failures per agent. When failures exceed threshold,
// the agent is "opened" (removed from routing) for a cooldown period.
// Successful invocations reset the failure count.

interface BreakerState {
  failures: number
  openedAt: number | null  // epoch ms when breaker opened, null = closed
}

const DEFAULT_THRESHOLD = 3        // consecutive failures to open
const DEFAULT_COOLDOWN_MS = 300_000 // 5 minutes

class CircuitBreaker {
  private states = new Map<string, BreakerState>()
  private threshold: number
  private cooldownMs: number

  constructor(threshold = DEFAULT_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  /** Record a failed invocation. Returns true if breaker just opened. */
  recordFailure(agent: string): boolean {
    const s = this.get(agent)
    s.failures++
    if (s.failures >= this.threshold && s.openedAt === null) {
      s.openedAt = Date.now()
      return true // breaker just opened
    }
    return false
  }

  /** Record a successful invocation. Resets failure count and closes breaker. */
  recordSuccess(agent: string): void {
    this.states.delete(agent)
  }

  /** Check if an agent is currently blocked (breaker open). */
  isOpen(agent: string): boolean {
    const s = this.states.get(agent)
    if (!s || s.openedAt === null) return false
    // Check if cooldown has expired
    if (Date.now() - s.openedAt > this.cooldownMs) {
      // Half-open — reset on next success
      s.openedAt = null
      s.failures = 0
      return false
    }
    return true
  }

  /** Get status for display / debug. */
  getStatus(agent: string): { failures: number; open: boolean; openedAt: number | null } {
    const s = this.get(agent)
    return { failures: s.failures, open: s.openedAt !== null, openedAt: s.openedAt }
  }

  /** List all agents currently open. */
  listOpen(): string[] {
    const open: string[] = []
    for (const [agent] of this.states) {
      if (this.isOpen(agent)) open.push(agent)
    }
    return open
  }

  private get(agent: string): BreakerState {
    let s = this.states.get(agent)
    if (!s) {
      s = { failures: 0, openedAt: null }
      this.states.set(agent, s)
    }
    return s
  }
}

export const circuitBreaker = new CircuitBreaker()
