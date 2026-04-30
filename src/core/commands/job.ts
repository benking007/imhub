// /job (also /task) commands — create and manage persisted async jobs with subtask sessions

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { AgentBase } from '../agent-base.js'
import { createJob, getJob, listJobs, cancelJob, runJob, getJobStats, type Job } from '../job-board.js'

function formatJob(j: Job): string {
  const icon = { pending: '⏳', running: '🔄', completed: '✅', failed: '❌', cancelled: '🚫' }[j.status] || '❓'
  const ts = new Date(j.created_at + 'Z').toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const preview = j.prompt.substring(0, 50) + (j.prompt.length > 50 ? '...' : '')
  return `${icon} #${j.id} ${j.agent}: ${preview} [${j.status}] · ${ts}`
}

export async function handleJobCommand(
  args: string,
  ctx: RouteContext
): Promise<string | AsyncGenerator<string>> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'
  const rest = parts.slice(1).join(' ')

  switch (sub) {
    case 'list':
    case 'ls': {
      const filter = parts[1] as Job['status'] | undefined
      const jobs = listJobs(10, filter)
      if (!jobs.length) return '📋 暂无任务。\n\n使用 /job create <agent> <prompt> 创建新任务。'
      const stats = getJobStats()
      return `📋 **任务列表** (总 ${stats.total} · 待 ${stats.pending} · 运行 ${stats.running} · 完 ${stats.completed} · 败 ${stats.failed})

${jobs.map(formatJob).join('\n')}

/job create <agent> <prompt>  创建
/job check <id>  查看详情
/job cancel <id>  取消
/job run <id>  立即运行`
    }

    case 'create':
    case 'c': {
      if (!rest) return '用法: /job create <agent> <prompt>\n\n例如: /job create opencode 分析这段代码的性能问题'
      const spaceIdx = rest.indexOf(' ')
      if (spaceIdx < 0) return '用法: /job create <agent> <prompt>\n\n请提供 agent 名称和任务内容。'
      const agentName = rest.slice(0, spaceIdx)
      const prompt = rest.slice(spaceIdx + 1).trim()
      if (!prompt) return '请提供任务内容。'

      const agent = registry.findAgent(agentName)
      if (!agent) return `❌ Agent "${agentName}" not found.`

      const id = createJob(agent.name, prompt)
      return `✅ 任务 #${id} 已创建

Agent: ${agent.name}
状态: 待执行

使用 /job run ${id} 开始执行，或 /job list 查看所有任务。`
    }

    case 'check':
    case 'get':
    case 'g': {
      const id = parseInt(parts[1] || '', 10)
      if (isNaN(id)) return '用法: /job check <id>'
      const job = getJob(id)
      if (!job) return `❌ 未找到任务 #${id}。`
      const statusLabel = { pending: '⏳ 待执行', running: '🔄 运行中', completed: '✅ 已完成', failed: '❌ 失败', cancelled: '🚫 已取消' }
      let msg = `📋 **任务 #${job.id}**

Agent: ${job.agent}
状态: ${statusLabel[job.status] || job.status}
创建: ${job.created_at}`
      if (job.completed_at) msg += `\n完成: ${job.completed_at}`
      msg += `\n\n内容: ${job.prompt}`
      if (job.result) msg += `\n\n---\n结果:\n${job.result.length > 500 ? job.result.slice(0, 500) + '...' : job.result}`
      if (job.error) msg += `\n\n错误: ${job.error}`
      if (job.status === 'completed') msg += `\n\n/job run ${job.id} 重新执行`
      if (job.status === 'pending') msg += `\n\n/job run ${job.id} 开始执行`
      return msg
    }

    case 'run':
    case 'r': {
      const id = parseInt(parts[1] || '', 10)
      if (isNaN(id)) return '用法: /job run <id>'
      const job = getJob(id)
      if (!job) return `❌ 未找到任务 #${id}。`
      if (job.status === 'running') return `🔄 任务 #${id} 已在运行中。`

      const agent = registry.findAgent(job.agent)
      if (!agent) return `❌ Agent "${job.agent}" not found.`

      // Fire and forget with signal support for cancellation
      const isAgentBaseAgent = agent instanceof AgentBase
      runJob(id, async function* (j, logger, signal) {
        if (isAgentBaseAgent) {
          const ba = agent as unknown as AgentBase
          const result = await ba.spawnAndCollect(j.prompt, signal)
          if (result) yield result
        } else {
          const generator = agent.sendPrompt(`job-${j.id}`, j.prompt, [])
          for await (const chunk of generator) {
            if (signal.aborted) break
            yield chunk
          }
        }
      }, ctx.logger).catch(() => {})

      return `🔄 任务 #${id} 已开始运行。

使用 /job check ${id} 查看结果。`
    }

    case 'cancel':
    case 'x': {
      const id = parseInt(parts[1] || '', 10)
      if (isNaN(id)) return '用法: /job cancel <id>'
      if (cancelJob(id)) return `🚫 任务 #${id} 已取消。`
      return `❌ 无法取消任务 #${id}。可能不存在或已结束。`
    }

    case 'switch':
    case 'sw': {
      const arg = parts[1]
      if (!arg) return '用法: /job switch <id>  或  /job switch main'
      if (arg === 'main' || arg === '0') {
        await sessionManager.setActiveSubtask(ctx.platform, ctx.channelId, ctx.threadId, null)
        return '✅ 已返回主会话。'
      }
      const id = parseInt(arg, 10)
      if (isNaN(id)) return '用法: /job switch <id>  或  /job switch main'
      const job = getJob(id)
      if (!job) return `❌ 未找到任务 #${id}。`
      await sessionManager.setActiveSubtask(ctx.platform, ctx.channelId, ctx.threadId, id)
      // Also create/update subtask metadata in session
      await sessionManager.updateSubtask(ctx.platform, ctx.channelId, ctx.threadId, id, {
        id, agent: job.agent, prompt: job.prompt,
        status: 'running', createdAt: new Date(),
      })
      return `✅ 已进入任务 #${id} 的会话 (${job.agent})。\n\n直接发送消息继续对话。\n/job switch main 返回主会话。`
    }

    case 'collect':
    case 'cl': {
      const id = parseInt(parts[1] || '', 10)
      if (isNaN(id)) return '用法: /job collect <id>'
      const job = getJob(id)
      if (!job) return `❌ 未找到任务 #${id}。`
      if (!job.result) return `⚠️ 任务 #${id} (${job.status}) 暂无结果。`

      // Summarize via main agent
      const existingSession = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
      const mainAgent = existingSession?.agent || ctx.defaultAgent
      const agent = registry.findAgent(mainAgent)
      if (!agent) return `❌ Agent "${mainAgent}" not found.`

      const summaryPrompt = `Review and summarize this task result from ${job.agent}:\n\n---\n${job.result}\n---\n\nProvide a concise summary.`
      ctx.logger.info({ event: 'task.collect', taskId: id, agent: mainAgent })
      // Return the generator — caller will stream
      const generator = agent.sendPrompt(`collect-${id}`, summaryPrompt, [])
      return (async function* () {
        for await (const chunk of generator) yield chunk
      })()
    }

    default:
      return '用法: /job [list|create|check|run|cancel|switch|collect]\n\n也支持 /task 作为 /job 的别名。'
  }
}
