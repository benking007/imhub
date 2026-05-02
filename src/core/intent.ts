// Intent classifier — rule-based agent routing
//
// Phase 2: keyword matching with sticky session bias.
// Phase 2b (future): small LLM for topic classification.

import type { Logger } from 'pino'
import { registry } from './registry.js'
import { circuitBreaker } from './circuit-breaker.js'

/** Per-agent keyword profile for topic matching */
interface AgentProfile {
  keywords: string[]    // matched case-insensitive against message text
  weight: number        // base score multiplier (1.0 = neutral, < 1 = prefer others)
}

const PROFILES: Record<string, AgentProfile> = {
  'opencode': {
    keywords: ['代码', 'code', '编程', 'refactor', '重构', 'bug', '修复', 'fix', 'git', 'commit', 'deploy', 'build',
      'test', '测试', 'api', 'server', '后端', 'frontend', '前端', 'sql', '数据库', 'database',
      'python', 'typescript', 'javascript', 'rust', 'go', 'java',
      'shell', 'bash', '命令行', 'terminal', 'config', '配置', 'docker', 'container'],
    // Was 1.2 — same keywords also match claude-code, so the 0.2 advantage
    // would push routing to opencode whenever the message mentioned any coding
    // term. With sticky now an absolute lock (see classifyIntent below) this
    // weight only matters for the very first message on a fresh thread, but we
    // keep weights neutral so ordering comes from topic rules + defaultAgent.
    weight: 1.0,
  },
  'claude-code': {
    keywords: ['代码', 'code', '编程', 'refactor', '分析', 'analyze', 'architecture', '架构',
      'design', '设计', 'review', '审查', 'explain', '解释', '文档', 'documentation',
      'reasoning', '推理', 'complex', '复杂', 'research', '研究'],
    weight: 1.0,
  },
  'codex': {
    keywords: ['代码', 'code', 'bug', 'fix', '修复', 'quick', '快速', 'small', '简单', 'simple'],
    weight: 0.9,
  },
  'copilot': {
    keywords: ['代码', 'code', 'suggest', '建议', 'autocomplete', '补全', 'copilot'],
    weight: 0.8,
  },
}

// Additional routing: global topic fallbacks
interface TopicRule {
  pattern: RegExp
  agent: string
  description: string
}

// `\b` only matches between ASCII word chars and other chars — it does
// nothing for CJK. We split keywords into ASCII (uses \b) and CJK
// (boundary-free includes). Both branches are OR'd into one regex so
// callers still get a single .test() call.
function isCJK(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) || 0
    if (cp >= 0x3000) return true
  }
  return false
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function topic(words: string[], agent: string, description: string): TopicRule {
  const ascii = words.filter((w) => !isCJK(w)).map(escapeReg)
  const cjk = words.filter((w) => isCJK(w)).map(escapeReg)
  const parts: string[] = []
  if (ascii.length) parts.push(`\\b(?:${ascii.join('|')})\\b`)
  if (cjk.length) parts.push(`(?:${cjk.join('|')})`)
  return { pattern: new RegExp(parts.join('|'), 'iu'), agent, description }
}

const TOPIC_RULES: TopicRule[] = [
  topic(['git', 'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'stash'], 'opencode', 'git operations'),
  topic(['test', '测试', 'spec', 'coverage', 'mock', 'stub'], 'opencode', 'testing'),
  topic(['docker', 'container', 'kubernetes', 'k8s', 'deploy', 'ci', 'cd'], 'opencode', 'devops'),
  topic(['sql', 'database', 'db', '查询', 'select', 'insert', 'update', 'delete'], 'opencode', 'database'),
  topic(['review', '审查', 'audit', '检查'], 'claude-code', 'code review'),
  topic(['explain', '解释', 'what is', '为什么', 'how does', '怎么回事'], 'claude-code', 'explanation'),
]

export interface IntentResult {
  agent: string
  score: number
  reason: string
  triggeredBy: 'explicit' | 'sticky' | 'keyword' | 'topic' | 'fallback'
}

/**
 * Classify a user message and return the best agent to handle it.
 */
export function classifyIntent(
  text: string,
  stickyAgent?: string,
  logger?: Logger
): IntentResult {
  const available = registry.listAgents().filter(a => !circuitBreaker.isOpen(a))
  if (available.length === 0) {
    throw new Error('No agents available')
  }

  // Sticky is an absolute lock: once a thread is bound to an agent, only an
  // explicit /<agent> command (or /new) can change it. Without this, a single
  // keyword in a long-running thread could outscore the sticky bonus and
  // silently swap agents — the "agent drift" symptom users hit after long
  // pauses or across days. See router.ts:default → classifyIntent caller.
  if (stickyAgent && available.includes(stickyAgent)) {
    logger?.debug({ event: 'intent.sticky_lock', agent: stickyAgent },
      `[intent] sticky lock honored (no classification)`)
    return {
      agent: stickyAgent,
      score: 0,
      reason: 'sticky lock (no classification)',
      triggeredBy: 'sticky',
    }
  }

  // Score per agent. Agents missing from PROFILES (e.g. user-installed
  // custom ACP agents) get a default neutral weight so they remain
  // selectable when no explicit signal favors a profiled agent.
  const DEFAULT_WEIGHT = 0.5
  const scores = new Map<string, { score: number; reasons: string[]; weight: number }>()
  for (const a of available) {
    const profile = PROFILES[a]
    scores.set(a, {
      score: 0,
      reasons: profile ? [] : ['default weight (no profile)'],
      weight: profile?.weight ?? DEFAULT_WEIGHT,
    })
  }

  const lower = text.toLowerCase()

  // 1. Topic rule matching
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(text)) {
      const s = scores.get(rule.agent)
      if (s) {
        s.score += 2
        s.reasons.push(`topic: ${rule.description}`)
      }
    }
  }

  // 2. Keyword matching (uses each agent's own weight; profile-less agents
  // can't keyword-match because they have no keywords list, but they still
  // earn their base weight below).
  for (const [agent, profile] of Object.entries(PROFILES)) {
    const s = scores.get(agent)
    if (!s) continue

    for (const kw of profile.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        s.score += 1 * profile.weight
        s.reasons.push(`keyword: "${kw}"`)
      }
    }
  }

  // 3. Base weight per agent (so a profile-less custom agent has a non-zero
  // floor and won't be permanently dominated).
  for (const [, s] of scores) {
    s.score += s.weight * 0.5
  }

  // 4. Sticky session bias
  if (stickyAgent && scores.has(stickyAgent)) {
    const s = scores.get(stickyAgent)!
    s.score += 3
    s.reasons.push('sticky: last used agent')
  }

  // Tie-break order:
  //   1. higher score wins
  //   2. sticky agent (if present in scores)
  //   3. PROFILES declaration order (preserves intentional priority)
  //   4. alphabetical, for full determinism
  const profileOrder = Object.keys(PROFILES)
  const rankOf = (agent: string): number => {
    if (stickyAgent && agent === stickyAgent) return -1
    const idx = profileOrder.indexOf(agent)
    return idx === -1 ? profileOrder.length : idx
  }

  let best: { agent: string; score: number; reasons: string[] } | null = null
  for (const [agent, s] of scores) {
    if (!best) { best = { agent, score: s.score, reasons: s.reasons }; continue }
    if (s.score > best.score) {
      best = { agent, score: s.score, reasons: s.reasons }
      continue
    }
    if (s.score === best.score) {
      const cmp = rankOf(agent) - rankOf(best.agent)
      if (cmp < 0 || (cmp === 0 && agent < best.agent)) {
        best = { agent, score: s.score, reasons: s.reasons }
      }
    }
  }
  if (!best) {
    // fallback to first available
    const agent = available[0]
    return { agent, score: 0, reason: 'fallback (no matches)', triggeredBy: 'fallback' }
  }

  const isSticky = stickyAgent === best.agent && best.reasons.includes('sticky: last used agent')
  const hasTopic = best.reasons.some(r => r.startsWith('topic:'))
  const hasKeyword = best.reasons.some(r => r.startsWith('keyword:'))
  const triggeredBy: IntentResult['triggeredBy'] =
    hasTopic ? 'topic'
    : hasKeyword ? 'keyword'
    : isSticky ? 'sticky'
    : 'fallback'

  return {
    agent: best.agent,
    score: Math.round(best.score * 100) / 100,
    reason: best.reasons.join(', ') || `base score ${best.score.toFixed(1)}`,
    triggeredBy,
  }
}
