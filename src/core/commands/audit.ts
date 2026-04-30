// /audit command — query recent agent invocations

import type { RouteContext } from '../router.js'
import { queryInvocations, getStats } from '../audit-log.js'
import type { InvocationRow } from '../audit-log.js'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}min`
}

function formatCost(c: number): string {
  if (c === 0) return '-'
  return `$${c.toFixed(4)}`
}

export async function handleAuditCommand(
  args: string,
  _ctx: RouteContext
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const opts: { limit: number; agent?: string; platform?: string; userId?: string; intent?: string; days?: number } = { limit: 10 }

  for (const p of parts) {
    if (p.startsWith('agent=')) opts.agent = p.slice(6)
    else if (p.startsWith('platform=')) opts.platform = p.slice(9)
    else if (p.startsWith('user=')) opts.userId = p.slice(5)
    else if (p.startsWith('intent=')) opts.intent = p.slice(7)
    else if (p.startsWith('days=')) {
      const n = parseInt(p.slice(5), 10)
      if (Number.isFinite(n) && n > 0) opts.days = n
    } else {
      const n = parseInt(p, 10)
      if (Number.isFinite(n) && n > 0) opts.limit = Math.min(n, 1000)
    }
  }

  const rows = queryInvocations(opts)
  const stats = getStats()

  if (rows.length === 0) {
    return '📊 暂无审计记录。'
  }

  const lines = rows.map((r: InvocationRow) => {
    const icon = r.success ? '✅' : '❌'
    const intentTag = r.intent && r.intent !== 'default' ? ` ⟨${r.intent}⟩` : ''
    return `${icon} \`${r.trace_id.slice(0, 8)}\` ${r.platform}/${r.agent}${intentTag} · ${formatDuration(r.duration_ms)} ← ${r.prompt_len}c → ${r.response_len}c · ${formatCost(r.cost)}`
  })

  return `📊 **最近 ${rows.length} 次调用**

${lines.join('\n')}

总计: ${stats.total} 次 · 总花费 ${formatCost(stats.totalCost)}
${Object.entries(stats.byAgent).map(([k, v]) => `  ${k}: ${v} 次`).join('\n')}

/audit <n>  最近 n 条
/audit agent=opencode  按 agent 过滤
/audit user=wx_xyz  按 userId 过滤
/audit intent=topic  按路由原因过滤 (explicit / topic / keyword / sticky / fallback)
/audit days=7  最近 7 天`
}
