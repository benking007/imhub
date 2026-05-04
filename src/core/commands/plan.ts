// /plan [on|off] — toggle plan mode for the active agent
//
// Plan mode is a per-session flag the router forwards to the agent adapter:
//   • claude-code  → spawns with `--permission-mode plan` (read-only)
//   • opencode     → routes through the built-in `plan` agent
//   • other agents → ignore the flag (no-op)
//
// Persisted on session.planMode so it survives across turns and across the
// /oc ↔ /cc agent switch (intent travels with the conversation, not with
// the chosen CLI).
//
// Emergency kill switch: `IMHUB_DISABLE_PLAN_MODE=1` makes /plan return a
// "disabled" message without touching session state. Useful for ops to roll
// back the feature without redeploying.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

const ON_TOKENS = new Set(['on', 'enter', 'start', 'enable', '开', '开启'])
const OFF_TOKENS = new Set(['off', 'exit', 'stop', 'disable', '关', '关闭'])

export async function handlePlanCommand(args: string, ctx: RouteContext): Promise<string> {
  if (process.env.IMHUB_DISABLE_PLAN_MODE === '1') {
    return '🚫 Plan 模式已通过 IMHUB_DISABLE_PLAN_MODE 全局禁用，请联系运维。'
  }

  const token = args.trim().toLowerCase()
  const existing = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)

  if (!token) {
    const cur = existing?.planMode ? 'on' : 'off'
    const agent = existing?.agent || ctx.defaultAgent
    return `📐 Plan 模式: \`${cur}\`（当前 agent: ${agent}）

/plan on   开启（claude → 只读规划；opencode → 切到 plan agent）
/plan off  关闭，恢复正常执行模式

plan 模式下文件不会被修改，适合先讨论方案再动手。`
  }

  // Ensure a session exists so the patch is durable. Defer to the active
  // sticky agent if one exists, else the configured default.
  await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId,
    existing?.agent || ctx.defaultAgent,
  )

  if (ON_TOKENS.has(token)) {
    if (existing?.planMode) return '✅ Plan 模式已开启（无变化）。'
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { planMode: true })
    return '✅ Plan 模式已开启 — 接下来 agent 只规划不动手。/plan off 恢复。'
  }

  if (OFF_TOKENS.has(token)) {
    if (!existing?.planMode) return 'ℹ️ Plan 模式本来就是关闭状态。'
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { planMode: false })
    return '✅ Plan 模式已关闭 — 恢复正常执行模式。'
  }

  return `⚠️ 无效参数: \`${token}\`

/plan on | off`
}
