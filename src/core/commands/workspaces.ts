// /workspaces command — inspect multi-tenant workspace state
//
// /workspaces           list all workspaces
// /workspaces show <id> show details + the workspace this user resolves to
// /workspaces whoami    show which workspace the current user resolves to

import type { RouteContext } from '../router.js'
import { workspaceRegistry } from '../workspace.js'

export async function handleWorkspacesCommand(
  args: string,
  ctx: RouteContext
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'

  switch (sub) {
    case 'list':
    case 'ls': {
      const all = workspaceRegistry.list()
      const myWs = workspaceRegistry.resolve(ctx.userId || 'unknown')
      const lines = all.map((w) => {
        const tag = w.id === myWs.id ? ' ← you' : ''
        const whitelist = w.agents.length === 0
          ? 'unrestricted'
          : w.agents.join(', ')
        const members = w.members === null ? 'open' : `${w.members} member(s)`
        return `• **${w.id}** (${w.name})${tag}\n  agents: ${whitelist}\n  members: ${members}\n  rateLimit: ${w.rateLimit.rate}/${w.rateLimit.intervalSec}s · burst=${w.rateLimit.burst}`
      })
      return `🏢 **Workspaces** (${all.length})\n\n${lines.join('\n\n')}\n\n用法: /workspaces show <id>  查看单个详情\n用法: /workspaces whoami  查看当前用户归属`
    }

    case 'show': {
      const id = parts[1]
      if (!id) return '用法: /workspaces show <id>'
      const ws = workspaceRegistry.get(id)
      if (!ws) return `❌ Workspace "${id}" not found.`
      const summary = workspaceRegistry.list().find((w) => w.id === id)!
      const whitelist = summary.agents.length === 0 ? 'unrestricted' : summary.agents.join(', ')
      const members = summary.members === null ? 'open (no member list)' : `${summary.members} explicit member(s)`
      return `🏢 **Workspace: ${ws.id}** (${ws.name})\n\nagents: ${whitelist}\nmembers: ${members}\nrateLimit: ${summary.rateLimit.rate} req / ${summary.rateLimit.intervalSec}s, burst=${summary.rateLimit.burst}`
    }

    case 'whoami': {
      const userId = ctx.userId || 'unknown'
      const ws = workspaceRegistry.resolve(userId)
      const cfg = workspaceRegistry.list().find((w) => w.id === ws.id)!
      return `👤 userId: \`${userId}\`\n🏢 workspace: **${ws.id}** (${ws.name})\nallowed agents: ${cfg.agents.length === 0 ? 'unrestricted' : cfg.agents.join(', ')}`
    }

    default:
      return '用法: /workspaces [list|show <id>|whoami]'
  }
}
