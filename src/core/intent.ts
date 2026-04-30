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
    weight: 1.2,  // prefer opencode for coding tasks
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

const TOPIC_RULES: TopicRule[] = [
  { pattern: /\b(git|commit|push|pull|merge|rebase|branch|stash)\b/i, agent: 'opencode', description: 'git operations' },
  { pattern: /\b(test|测试|spec|coverage|mock|stub)\b/i, agent: 'opencode', description: 'testing' },
  { pattern: /\b(docker|container|kubernetes|k8s|deploy|ci|cd)\b/i, agent: 'opencode', description: 'devops' },
  { pattern: /\b(sql|database|db|查询|select|insert|update|delete)\b/i, agent: 'opencode', description: 'database' },
  { pattern: /\b(review|审查|review|audit|检查)\b/i, agent: 'claude-code', description: 'code review' },
  { pattern: /\b(explain|解释|what is|为什么|how does|怎么回事)\b/i, agent: 'claude-code', description: 'explanation' },
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

  // Score per agent
  const scores = new Map<string, { score: number; reasons: string[] }>()
  for (const a of available) {
    scores.set(a, { score: 0, reasons: [] })
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

  // 2. Keyword matching per agent
  for (const [agent, profile] of Object.entries(PROFILES)) {
    const s = scores.get(agent)
    if (!s) continue

    for (const kw of profile.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        s.score += 1 * profile.weight
        s.reasons.push(`keyword: "${kw}"`)
      }
    }
    // Add base weight
    s.score += profile.weight * 0.5
  }

  // 3. Sticky session bias
  if (stickyAgent && scores.has(stickyAgent)) {
    const s = scores.get(stickyAgent)!
    s.score += 3
    s.reasons.push('sticky: last used agent')
  }

  // Pick best
  let best: { agent: string; score: number; reasons: string[] } | null = null
  for (const [agent, s] of scores) {
    if (!best || s.score > best!.score) {
      best = { agent, score: s.score, reasons: s.reasons }
    }
  }
  if (!best) {
    // fallback to first available
    const agent = available[0]
    return { agent, score: 0, reason: 'fallback (no matches)', triggeredBy: 'fallback' }
  }

  const triggeredBy = stickyAgent === best.agent ? 'sticky' : best.reasons.length > 0 ? 'keyword' : 'fallback'
  return {
    agent: best.agent,
    score: Math.round(best.score * 100) / 100,
    reason: best.reasons.join(', ') || `base score ${best.score.toFixed(1)}`,
    triggeredBy,
  }
}
