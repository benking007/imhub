// /router commands — inspect and debug routing decisions

import type { RouteContext } from '../router.js'
import { classifyIntent } from '../intent.js'
import { circuitBreaker } from '../circuit-breaker.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'

export async function handleRouterCommand(
  args: string,
  ctx: RouteContext
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const subcommand = parts[0] || 'status'
  const rest = parts.slice(1).join(' ')

  switch (subcommand) {
    case 'status':
    case 's': {
      const agents = registry.listAgents()
      const lines = agents.map(a => {
        const breaker = circuitBreaker.getStatus(a)
        const icon = breaker.open ? '⛔' : '✅'
        const extra = breaker.open
          ? ` (blocked: ${breaker.failures} failures)`
          : breaker.failures > 0
            ? ` (${breaker.failures} recent failures)`
            : ''
        return `${icon} ${a}${extra}`
      })
      return `📊 **Router Status**\n\n${lines.join('\n')}\n\n/router policy  查看路由策略\n/router explain <message>  预测路由去向`
    }

    case 'policy':
    case 'p': {
      return `📋 **路由策略 (Phase 2 · 规则引擎)**

1. 显式命令  — /<agent> 直接切换
2. Sticky 会话 — 继续使用上一轮的 agent (+3 权重)
3. 主题规则  — git/test/sql/review 等关键词映射到专用 agent (+2)
4. 关键词匹配 — agent 画像关键词权重 (+0.5~1.2 每匹配)
5. 兜底      — 默认 agent 或首家可用

断路保护: 连续 3 次失败 → 5 分钟冷却
`
    }

    case 'explain':
    case 'e': {
      if (!rest) return '用法: /router explain <消息内容>\n\n预测该消息会被路由到哪个 agent'

      const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
      const sticky = session?.agent

      const result = classifyIntent(rest, sticky, ctx.logger)
      return `🔍 **路由预测**

消息: "${rest.substring(0, 80)}${rest.length > 80 ? '...' : ''}"

→ Agent: **${result.agent}** (score: ${result.score})
  触发: ${result.triggeredBy}
  原因: ${result.reason}

当前 sticky: ${sticky || '无'}`
    }

    default:
      return `用法: /router [status|policy|explain <msg>]`
  }
}
