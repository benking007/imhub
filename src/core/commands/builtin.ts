// Built-in commands: /start /status /help /agents /new

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'

export async function handleBuiltInCommand(
  command: 'start' | 'status' | 'help' | 'agents' | 'new',
  ctx: RouteContext
): Promise<string> {
  switch (command) {
    case 'start':
      return `👋 Welcome to IM Hub!\n\nI'm your AI assistant hub. Send me a message and I'll route it to the right AI agent.\n\nUse /help to see available commands.\nUse /agents to list available AI agents.`

    case 'status':
      return `📊 IM hub Status\n\nPlatform: Connected\nAgent: Ready\n\nSend a message to start!`

    case 'help':
      return `📖 IM hub Commands\n\nBuilt-in Commands:\n/agents - List available agents\n/new - Start a new conversation (clear history)\n/status - Show connection status\n/audit [n] - View recent invocations\n/approval - List/clear in-session auto-allow rules (alias /auto)\n/plan on|off - Toggle plan (read-only) mode for the active agent\n/<agent> <prompt> - Switch to agent and send prompt\n\nAgent Commands:\n/test - Run tests\n/review - Code review\n/commit - Commit changes\n/push - Push to remote\n/diff - Show changes\n/shell - Execute shell commands\n/bug - Find and fix bugs\n/explain - Explain code\n\nExample: /claude explain this code`

    case 'agents':
      const agents = registry.listAgents()
      if (agents.length === 0) {
        return '⚠️ No agents registered yet.'
      }
      return `🤖 Available Agents\n\n${agents.map(a => `• ${a}`).join('\n')}\n\nUse /<agent> to switch.`

    case 'new':
      const session = await sessionManager.resetConversation(ctx.platform, ctx.channelId, ctx.threadId)
      if (session) {
        return `🆕 New conversation started with ${session.agent}.\n\nPrevious context has been cleared.`
      }
      return `🆕 Ready to start a new conversation.\n\nSend a message to begin.`
  }
}
