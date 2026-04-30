// /stats — session token usage & cost

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString('en-US')
}

export async function handleStatsCommand(_args: string, ctx: RouteContext): Promise<string> {
  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  if (!session) return '📊 当前没有活跃会话。'

  const usage = (session as any).usage
  if (!usage || !usage.turns) return '📊 本会话尚未产生 AI 调用。'

  const total = (usage.tokens?.input || 0) + (usage.tokens?.output || 0) +
    (usage.tokens?.reasoning || 0) + (usage.tokens?.cacheRead || 0) + (usage.tokens?.cacheWrite || 0)
  const costCNY = (usage.cost || 0) * 7.2

  const ago = Math.round((Date.now() - new Date(usage.startedAt).getTime()) / 60000)
  const agoStr = ago < 60 ? `${ago} 分钟前` : `${(ago / 60).toFixed(1)} 小时前`

  return `📊 **当前会话统计**

💰 **花费**: $${(usage.cost || 0).toFixed(4)} (≈ ¥${costCNY.toFixed(2)})
🔢 **总 Tokens**: ${formatNum(total)}

**Tokens 明细**
- 输入: ${formatNum(usage.tokens?.input || 0)}
- 输出: ${formatNum(usage.tokens?.output || 0)}
- 推理: ${formatNum(usage.tokens?.reasoning || 0)}

**会话信息**
- 轮次: ${usage.turns}
- 步骤: ${usage.steps || 0}
- 模型: \`${session.model || 'default'}\`
- 思考: \`${session.variant || 'auto'}\`
- 开始: ${agoStr}`
}
