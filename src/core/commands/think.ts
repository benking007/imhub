// /think [level] — thinking/reasoning depth

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

export async function handleThinkCommand(args: string, ctx: RouteContext): Promise<string> {
  const level = args.trim().toLowerCase()
  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)

  if (!level) {
    const cur = session?.variant || 'auto'
    return `💭 当前思考深度: \`${cur}\`\n\n/think high | low | off | auto`
  }

  if (level === 'off' || level === 'none') {
    if (session) { session.variant = '' }
    return '✅ 已关闭深度思考。'
  }
  if (level === 'auto') {
    if (session) { session.variant = '' }
    return '✅ 思考深度: auto（自动选择）。'
  }
  if (['high', 'low', 'max', 'minimal'].includes(level)) {
    if (session) { session.variant = level }
    return `✅ 思考深度: \`${level}\``
  }

  return `⚠️ 无效值: \`${level}\`\n/think high | low | max | minimal | off | auto`
}
