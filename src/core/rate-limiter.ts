// Rate limiter — per-user token bucket for agent invocations

interface Bucket {
  tokens: number
  lastRefill: number
}

const DEFAULT_RATE = 10        // tokens per interval
const DEFAULT_INTERVAL_MS = 60_000 // 1 minute
const DEFAULT_BURST = 15       // max tokens in bucket

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private rate: number
  private intervalMs: number
  private burst: number

  constructor(rate = DEFAULT_RATE, intervalMs = DEFAULT_INTERVAL_MS, burst = DEFAULT_BURST) {
    this.rate = rate
    this.intervalMs = intervalMs
    this.burst = burst
  }

  /** Check if a request is allowed. Returns true if within limit. */
  allow(key: string): boolean {
    const b = this.getBucket(key)
    if (b.tokens > 0) {
      b.tokens--
      return true
    }
    return false
  }

  /** Get remaining tokens for a key. */
  remaining(key: string): number {
    return this.getBucket(key).tokens
  }

  /** Get status for display. */
  status(key: string): { remaining: number; rate: number; intervalSec: number } {
    return {
      remaining: this.getBucket(key).tokens,
      rate: this.rate,
      intervalSec: Math.round(this.intervalMs / 1000),
    }
  }

  private getBucket(key: string): Bucket {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.burst, lastRefill: now }
      this.buckets.set(key, b)
      return b
    }
    // Refill tokens based on elapsed time
    const elapsed = now - b.lastRefill
    const refill = Math.floor(elapsed / this.intervalMs) * this.rate
    if (refill > 0) {
      b.tokens = Math.min(this.burst, b.tokens + refill)
      b.lastRefill = now
    }
    return b
  }
}

// Global instances
export const userLimiter = new RateLimiter(10, 60000, 15)    // 10 req/min per user
export const agentLimiter = new RateLimiter(30, 60000, 50)   // 30 req/min per agent
