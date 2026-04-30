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
  const opts: { limit: number; agent?: string; days?: number } = { limit: 10 }

  for (const p of parts) {
    if (p.startsWith('agent=')) opts.agent = p.slice(6)
    else if (p.startsWith('days=')) opts.days = parseInt(p.slice(5), 10) || undefined
    else if (parseInt(p, 10)) opts.limit = parseInt(p, 10)
  }

  const rows = queryInvocations(opts)
  const stats = getStats()

  if (rows.length === 0) {
    return '📊 暂无审计记录。'
  }

  const lines = rows.map((r: InvocationRow) => {
    const icon = r.success ? '✅' : '❌'
    const ts = new Date(r.ts + 'Z').toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return `${icon} \`${r.trace_id.slice(0, 8)}\` ${r.platform}/${r.agent} · ${formatDuration(r.duration_ms)} ← ${r.prompt_len}c → ${r.response_len}c`
  })

  return `📊 **最近 ${rows.length} 次调用**

${lines.join('\n')}

总计: ${stats.total} 次 · 总花费 ${formatCost(stats.totalCost)}
${Object.entries(stats.byAgent).map(([k, v]) => `  ${k}: ${v} 次`).join('\n')}

/audit <n>  最近 n 条
/audit agent=opencode  按 agent 过滤
/audit days=7  最近 7 天`
}
