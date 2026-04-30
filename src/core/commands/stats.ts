// /stats — session usage roll-up: cost, char throughput, turn count.
//
// Sources:
//   - sessionManager.recordUsage() is called from router.callAgentWithHistory
//     after every successful invocation, so session.usage is the live tally.
//   - Token counts are not reported here because not all agents surface
//     usage events; we report char counts which we always have.
//
// Cost in CNY uses an env-driven exchange rate (default 7.2) so users can
// override if their accounting team needs a different value.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K'
  return Math.round(n).toLocaleString('en-US')
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  const h = Math.floor(s / 3600)
  return `${h}h ${Math.floor((s % 3600) / 60)}m`
}

function fxRate(): number {
  const raw = process.env.IM_HUB_USD_TO_CNY
  if (raw) {
    const n = parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 7.2
}

export async function handleStatsCommand(_args: string, ctx: RouteContext): Promise<string> {
  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  if (!session) return '📊 当前没有活跃会话。'
  const usage = session.usage
  if (!usage || usage.turns === 0) return '📊 本会话尚未产生 AI 调用。'

  const startedAt = new Date(usage.startedAt)
  const ago = Date.now() - startedAt.getTime()
  const agoStr = ago < 60_000
    ? '不到 1 分钟前'
    : ago < 3600_000
      ? `${Math.round(ago / 60_000)} 分钟前`
      : `${(ago / 3600_000).toFixed(1)} 小时前`

  const costCNY = usage.costUsd * fxRate()
  const avgDuration = usage.turns > 0 ? usage.durationMsTotal / usage.turns : 0

  return `📊 **当前会话统计**

💰 **花费**: $${usage.costUsd.toFixed(4)} (≈ ¥${costCNY.toFixed(2)})
🔢 **轮次**: ${usage.turns}

**字符吞吐**
- 输入: ${fmtNum(usage.promptChars)}
- 输出: ${fmtNum(usage.responseChars)}

**会话信息**
- Agent: \`${session.agent}\`
- 模型: \`${session.model || 'default'}\`
- 思考: \`${session.variant || 'auto'}\`
- 累计耗时: ${fmtDuration(usage.durationMsTotal)} (平均 ${fmtDuration(avgDuration)}/次)
- 开始: ${agoStr}`
}
