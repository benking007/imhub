// LLM-backed intent fallback (P2-H).
//
// When the rule-based classifier produces a low-confidence result we
// ask a configured "judge agent" — itself one of the registered agents
// — to pick the best agent. Opt-in via env (IM_HUB_LLM_JUDGE_AGENT)
// or programmatic configureLLMJudge() so we never silently spend
// tokens by default.
//
// Caching: identical prompt+candidate-list pairs are memoized within a
// 10-minute window so repeated chat-room banter doesn't burn budget.

import type { AgentAdapter } from './types.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'intent-llm' })

const CACHE_TTL_MS = 10 * 60 * 1000
const RESPONSE_TIMEOUT_MS = 5_000

interface CachedDecision {
  agent: string
  reason: string
  ts: number
}

const cache = new Map<string, CachedDecision>()

export interface LLMJudgeConfig {
  /** Agent name used as the judge. Must already be registered. */
  agentName: string
  /** Score threshold below which the LLM is consulted (default 1.0). */
  threshold?: number
  /** Override the default 5s response timeout. */
  timeoutMs?: number
}

let config: LLMJudgeConfig | null = null

export function configureLLMJudge(cfg: LLMJudgeConfig | null): void {
  config = cfg
  cache.clear()
}

/** Read the judge configuration. Used by classifyIntent to know whether
 *  to attempt a fallback at all. */
export function getLLMJudge(): LLMJudgeConfig | null {
  return config
}

/** Probe env on first import so common deployments get auto-config. */
function autoFromEnv(): void {
  const name = process.env.IM_HUB_LLM_JUDGE_AGENT
  if (name && !config) {
    const threshold = parseFloat(process.env.IM_HUB_LLM_JUDGE_THRESHOLD || '1.0')
    config = {
      agentName: name,
      threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 1.0,
    }
  }
}
autoFromEnv()

function makeKey(text: string, candidates: string[]): string {
  return candidates.slice().sort().join('|') + '||' + text
}

function buildPrompt(text: string, candidates: string[]): string {
  return [
    'You are a router that picks the most appropriate agent for a user request.',
    'Reply with EXACTLY one agent name from the list — no explanation, no punctuation.',
    '',
    'Candidates:',
    ...candidates.map((c) => `  - ${c}`),
    '',
    `User request: ${text}`,
    '',
    'Best agent:',
  ].join('\n')
}

/**
 * Ask the judge agent which candidate to use. Returns null on any
 * failure path (timeout, judge unavailable, malformed response) so
 * the caller can keep its rule-based decision.
 */
export async function classifyWithLLM(
  text: string,
  candidates: string[],
  resolveAgent: (name: string) => AgentAdapter | undefined,
): Promise<{ agent: string; reason: string } | null> {
  if (!config) return null
  if (candidates.length === 0) return null

  const key = makeKey(text, candidates)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { agent: cached.agent, reason: `${cached.reason} (cached)` }
  }

  const judge = resolveAgent(config.agentName)
  if (!judge) {
    log.warn({ judge: config.agentName }, 'LLM judge agent not registered')
    return null
  }

  const timeoutMs = config.timeoutMs ?? RESPONSE_TIMEOUT_MS
  const prompt = buildPrompt(text, candidates)

  try {
    let acc = ''
    const generator = judge.sendPrompt(`llm-judge`, prompt, [])
    const collect = (async () => {
      for await (const chunk of generator) {
        acc += chunk
        if (acc.length > 4096) break  // guard runaway output
      }
    })()
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('LLM judge timed out')), timeoutMs))

    await Promise.race([collect, timeout])

    // Parse: take the first line, lowercase, strip punctuation, match
    // against candidates case-insensitively.
    const firstLine = acc.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
    const cleaned = firstLine.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const match = candidates.find((c) => c.toLowerCase() === cleaned)
      ?? candidates.find((c) => cleaned.includes(c.toLowerCase()))

    if (!match) {
      log.warn({ raw: firstLine, candidates }, 'LLM judge produced unrecognized output')
      return null
    }

    const decision = { agent: match, reason: `LLM judge picked ${match}` }
    cache.set(key, { ...decision, ts: Date.now() })
    return decision
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) },
      'LLM judge call failed')
    return null
  }
}

/** Test-only: clear cache so memoization doesn't leak between cases. */
export function _clearLLMCache(): void {
  cache.clear()
}
