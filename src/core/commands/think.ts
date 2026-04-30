// /think [level] — thinking/reasoning depth
//
// Stored on session.variant. Persisted via sessionManager.patchSession so
// the change survives a restart between turns.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

const VALID_LEVELS = new Set(['high', 'low', 'max', 'minimal'])

export async function handleThinkCommand(args: string, ctx: RouteContext): Promise<string> {
  const level = args.trim().toLowerCase()

  if (!level) {
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    const cur = session?.variant || 'auto'
    return `💭 当前思考深度: \`${cur}\`\n\n/think high | low | max | minimal | off | auto`
  }

  // Ensure a session exists so the patch is always durable.
  await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)

  if (level === 'off' || level === 'none' || level === 'auto') {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: '' })
    return level === 'auto'
      ? '✅ 思考深度: auto（自动选择）。'
      : '✅ 已关闭深度思考。'
  }
  if (VALID_LEVELS.has(level)) {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: level })
    return `✅ 思考深度: \`${level}\``
  }

  return `⚠️ 无效值: \`${level}\`\n/think high | low | max | minimal | off | auto`
}
