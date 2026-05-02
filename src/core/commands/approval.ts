// /approval command — list or clear in-session auto-approval rules.
//
// /approval         — list current auto-allow rules for this thread
// /approval clear   — drop every auto-allow rule for this thread
//
// Rules are scoped per (platform, channelId, threadId) — same key the
// approval-bus uses internally.

import type { RouteContext } from '../router.js'
import { approvalBus } from '../approval-bus.js'

function formatRuleKey(key: string): string {
  // Keys are stored as `${toolName}::${prefix}` — split for prettier rendering.
  const sep = key.indexOf('::')
  if (sep < 0) return key
  const tool = key.slice(0, sep)
  const prefix = key.slice(sep + 2)
  return `• ${tool}  前缀 "${prefix}"`
}

export async function handleApprovalCommand(
  args: string,
  ctx: RouteContext,
): Promise<string> {
  const sub = args.trim().toLowerCase()

  if (sub === 'clear' || sub === 'reset') {
    const before = approvalBus.getAutoAllowKeys(ctx.threadId)
    approvalBus.clearAutoAllowForThread(ctx.threadId)
    if (before.length === 0) return '🧹 当前没有自动放行规则，无需清空。'
    return `🧹 已清空本会话的 ${before.length} 条自动放行规则。`
  }

  const keys = approvalBus.getAutoAllowKeys(ctx.threadId)
  if (keys.length === 0) {
    return [
      '📋 本会话当前没有自动放行规则。',
      '',
      '在审批提示出现时回复 all（或 全部 / 总是）即可启用：',
      '将以 (工具, 入参前 5 字符) 为粒度，命中后 5s 内自动放行。',
    ].join('\n')
  }
  return [
    `📋 本会话自动放行规则 (${keys.length})`,
    '',
    ...keys.map(formatRuleKey),
    '',
    '撤销：触发审批后回 n（仅撤销该条规则） / /approval clear（全部清空）',
  ].join('\n')
}
