// /schedule command — manage cron-driven scheduled prompts (P2-F).
//
// /schedule list                                   list all schedules
// /schedule create <name> <agent> <cron> <prompt>  create
// /schedule delete <id>                            delete
// /schedule enable <id>                            enable
// /schedule disable <id>                           disable
// /schedule check <id>                             show details
//
// Cron expression is the standard 5-field POSIX format ("min hour dom mon dow").

import type { RouteContext } from '../router.js'
import {
  createSchedule, listSchedules, getSchedule, deleteSchedule, setEnabled,
} from '../schedule.js'
import { parseCron, nextOccurrence } from '../cron.js'

export async function handleScheduleCommand(
  args: string,
  _ctx: RouteContext
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'

  switch (sub) {
    case 'list':
    case 'ls': {
      const all = listSchedules()
      if (!all.length) return '🗓️ 暂无定时任务。\n\n用法: /schedule create <name> <agent> "<cron>" <prompt>'
      const lines = all.map((s) => {
        const flag = s.enabled ? '✅' : '⏸️'
        return `${flag} #${s.id} **${s.name}** (${s.agent})\n   cron: \`${s.cron}\`\n   下次: ${s.next_run}`
      })
      return `🗓️ **定时任务** (${all.length})\n\n${lines.join('\n\n')}\n\n/schedule check <id>  详情\n/schedule enable/disable <id>  启停\n/schedule delete <id>  删除`
    }

    case 'create':
    case 'c': {
      // /schedule create <name> <agent> "<cron>" <prompt...>
      if (parts.length < 5) {
        return '用法: /schedule create <name> <agent> "<cron expr>" <prompt>\n\n例如: /schedule create daily-report opencode "0 9 * * 1-5" 生成今天的销售日报'
      }
      const name = parts[1]
      const agent = parts[2]
      // The cron expression may be quoted — try to extract.
      const restJoined = parts.slice(3).join(' ')
      let cron: string
      let prompt: string
      const quoted = restJoined.match(/^"([^"]+)"\s+(.+)$/) || restJoined.match(/^'([^']+)'\s+(.+)$/)
      if (quoted) {
        cron = quoted[1]
        prompt = quoted[2]
      } else {
        // Best effort: assume the next 5 tokens are the cron expression
        const tokens = parts.slice(3)
        if (tokens.length < 6) return '用法: /schedule create <name> <agent> "<cron expr>" <prompt>'
        cron = tokens.slice(0, 5).join(' ')
        prompt = tokens.slice(5).join(' ')
      }

      try {
        // Validate before insert so we get a clean error.
        parseCron(cron)
        const id = createSchedule({ name, agent, cron, prompt })
        const next = nextOccurrence(parseCron(cron))
        return `✅ 定时任务 #${id} 已创建\n\nName: ${name}\nAgent: ${agent}\nCron: \`${cron}\`\n下次执行: ${next?.toISOString() || 'unknown'}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `❌ 创建失败: ${msg}`
      }
    }

    case 'delete':
    case 'rm': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /schedule delete <id>'
      return deleteSchedule(id)
        ? `✅ 定时任务 #${id} 已删除。`
        : `❌ 未找到 #${id}。`
    }

    case 'enable':
    case 'on': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /schedule enable <id>'
      return setEnabled(id, true)
        ? `✅ 定时任务 #${id} 已启用。`
        : `❌ 未找到 #${id}。`
    }

    case 'disable':
    case 'off': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /schedule disable <id>'
      return setEnabled(id, false)
        ? `⏸️ 定时任务 #${id} 已暂停。`
        : `❌ 未找到 #${id}。`
    }

    case 'check':
    case 'show': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /schedule check <id>'
      const s = getSchedule(id)
      if (!s) return `❌ 未找到 #${id}。`
      return `🗓️ **定时任务 #${s.id}** (${s.name})\n\nAgent: ${s.agent}\n状态: ${s.enabled ? '✅ 启用' : '⏸️ 已暂停'}\nCron: \`${s.cron}\`\n下次执行: ${s.next_run}\n上次执行: ${s.last_run || '从未'}\n通知 URL: ${s.notify_url || '无'}\n\nPrompt: ${s.prompt}`
    }

    default:
      return '用法: /schedule [list|create|delete|enable|disable|check]'
  }
}
