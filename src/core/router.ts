// Message router — parses commands and routes to agents

import type { ParsedMessage, ChatMessage } from './types.js'
import type { Logger } from 'pino'
import { registry } from './registry.js'
import { sessionManager } from './session.js'
import { isAgentAvailableCached, formatAgentNotAvailableError } from './onboarding.js'
import { handleBuiltInCommand } from './commands/builtin.js'
import { handleAgentCommand } from './commands/agent.js'
import { handleAuditCommand } from './commands/audit.js'
import { handleRouterCommand } from './commands/router.js'
import { handleJobCommand } from './commands/job.js'
import { logInvocation } from './audit-log.js'
import { circuitBreaker } from './circuit-breaker.js'
import { classifyIntent } from './intent.js'
import { userLimiter } from './rate-limiter.js'
import { workspaceRegistry } from './workspace.js'
import { getJob } from './job-board.js'

/** Route context passed through the routing pipeline */
export interface RouteContext {
  channelId: string
  threadId: string
  platform: string
  defaultAgent: string
  traceId: string
  logger: Logger
  userId?: string
}

/** Built-in coding agent commands forwarded to the active agent */
const AGENT_COMMANDS = new Set(['test', 'review', 'commit', 'push', 'diff', 'shell', 'bug', 'explain'])

/**
 * Parse a message to determine how to route it
 *
 * Command format: /alias prompt... or /agent-name prompt...
 * Built-in commands: /status, /help, /agents
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim()

  // Empty string → default agent with empty prompt
  if (!trimmed) {
    return { type: 'default', prompt: '' }
  }

  // Check for command prefix
  const match = trimmed.match(/^\/(\S+)\s*(.*)/)
  if (!match) {
    // No command prefix → default agent
    return { type: 'default', prompt: trimmed }
  }

  const [, cmd, rest] = match

  // Built-in commands
  if (cmd === 'start') return { type: 'command', command: 'start' }
  if (cmd === 'status') return { type: 'command', command: 'status' }
  if (cmd === 'help') return { type: 'command', command: 'help' }
  if (cmd === 'agents') return { type: 'command', command: 'agents' }
  if (cmd === 'new') return { type: 'command', command: 'new' }
  if (cmd === 'audit') return { type: 'audit', args: rest }
  if (cmd === 'router') return { type: 'router', args: rest }
  if (cmd === 'job' || cmd === 'task') return { type: 'job', args: rest }
  if (cmd === 'tasks') return { type: 'job', args: 'list' }
  if (cmd === 'check') return { type: 'job', args: `check ${rest}` }
  if (cmd === 'cancel') return { type: 'job', args: `cancel ${rest}` }
  if (cmd === 'switch') return { type: 'job', args: `switch ${rest}` }
  if (cmd === 'collect') return { type: 'job', args: `collect ${rest}` }

  // Check if it's an agent alias (registered agents take priority over generic commands)
  const agent = registry.findAgent(cmd)
  if (agent) {
    return { type: 'agent', agent: agent.name, prompt: rest }
  }

  // Agent built-in commands (only if no registered agent matches)
  if (AGENT_COMMANDS.has(cmd)) {
    return { type: 'agentCommand', command: cmd, prompt: rest }
  }

  // Unknown command
  return { type: 'error', prompt: trimmed, error: `Unknown command: ${cmd}` }
}

/**
 * Route a parsed message to the appropriate handler
 */
export async function routeMessage(
  parsed: ParsedMessage,
  ctx: RouteContext
): Promise<string | AsyncGenerator<string>> {
  switch (parsed.type) {
    case 'command': {
      return handleBuiltInCommand(parsed.command, ctx)
    }

    case 'agentCommand': {
      return handleAgentCommand(parsed.command, parsed.prompt, ctx)
    }

    case 'audit': {
      return handleAuditCommand(parsed.args, ctx)
    }

    case 'router': {
      return handleRouterCommand(parsed.args, ctx)
    }

    case 'job': {
      return handleJobCommand(parsed.args, ctx)
    }

    case 'agent': {
      const agent = registry.findAgent(parsed.agent)
      if (!agent) {
        return `❌ Agent "${parsed.agent}" not found. Use /agents to see available agents.`
      }

      if (circuitBreaker.isOpen(agent.name)) {
        return `⛔ ${agent.name} is temporarily unavailable (too many consecutive failures). Try again in a few minutes, or use another agent.`
      }

      if (!(await isAgentAvailableCached(agent.name))) {
        return formatAgentNotAvailableError(agent.name)
      }

      await sessionManager.switchAgent(ctx.platform, ctx.channelId, ctx.threadId, agent.name)

      if (!parsed.prompt) {
        return `✅ Switched to ${agent.name}`
      }

      const session = await sessionManager.getOrCreateSession(
        ctx.platform, ctx.channelId, ctx.threadId, agent.name
      )
      return callAgentWithHistory(agent, session.id, parsed.prompt, session.messages, ctx)
    }

    case 'error': {
      return `❓ ${parsed.error}\n\nUse /help to see available commands.`
    }

    case 'default': {
      // Rate limit check (per user)
      const limitKey = `${ctx.platform}:${ctx.userId || 'unknown'}`
      if (!userLimiter.allow(limitKey)) {
        const s = userLimiter.status(limitKey)
        return `⏱️ 请求过于频繁，请稍后再试。（${s.rate} 次/${s.intervalSec}秒，当前剩余 ${s.remaining}）`
      }

      const existingSession = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)

      // If active subtask, route message to subtask's independent session
      if (existingSession?.activeSubtaskId) {
        const tid = existingSession.activeSubtaskId
        const job = getJob(tid)
        if (!job) {
          return `❌ 任务 #${tid} 已不存在。使用 /job switch main 返回主会话。`
        }
        const tAgent = registry.findAgent(job.agent)
        if (!tAgent) {
          return `❌ 任务 #${tid} 的 Agent "${job.agent}" 不可用。`
        }
        const subSession = await sessionManager.getOrCreateSubSession(
          ctx.platform, ctx.channelId, ctx.threadId, tid, job.agent
        )
        if (!parsed.prompt) {
          return `💬 继续对话（任务 #${tid}, ${job.agent}）`
        }
        // Use sub-session for this turn
        await sessionManager.addMessage(ctx.platform, ctx.channelId, `${ctx.threadId}:sub:${tid}`, {
          role: 'user', content: parsed.prompt, timestamp: new Date()
        })
        return callAgentWithHistory(tAgent, subSession.id, parsed.prompt, subSession.messages, ctx)
      }

      // Use intent classifier to pick best agent
      const stickyAgent = existingSession?.agent
      let agentName: string
      let intent: string = 'fallback'

      try {
        const classification = classifyIntent(parsed.prompt, stickyAgent, ctx.logger)
        agentName = classification.agent
        intent = classification.triggeredBy
        ctx.logger.info({ event: 'router.intent', agent: agentName, intent, score: classification.score, reason: classification.reason })
      } catch {
        agentName = stickyAgent || ctx.defaultAgent
        ctx.logger.warn({ event: 'router.intent.failed', fallback: agentName })
      }

      const agent = registry.findAgent(agentName)
      if (!agent) {
        return `❌ Agent "${agentName}" not configured.`
      }

      if (circuitBreaker.isOpen(agent.name)) {
        const openAgents = circuitBreaker.listOpen().join(', ')
        return `⛔ ${agent.name} is temporarily unavailable (circuit breaker open).\nCurrently blocked: ${openAgents || 'none'}\n\nTry /agents to see available agents, or wait a few minutes.`
      }

      // Workspace agent whitelist check
      const ws = workspaceRegistry.resolve(ctx.userId || 'unknown')
      if (!ws.hasAgent(agent.name)) {
        return `🚫 Agent "${agent.name}" is not available in your workspace.\n\nTry /agents to see available agents.`
      }

      if (!(await isAgentAvailableCached(agent.name))) {
        return formatAgentNotAvailableError(agent.name)
      }

      if (!parsed.prompt) {
        return '💬 Send a message to chat with the agent.'
      }

      // Switch session agent if intent picked a different one
      if (agentName !== stickyAgent) {
        await sessionManager.switchAgent(ctx.platform, ctx.channelId, ctx.threadId, agentName)
      }

      const session = await sessionManager.getOrCreateSession(
        ctx.platform, ctx.channelId, ctx.threadId, agentName
      )
      return callAgentWithHistory(agent, session.id, parsed.prompt, session.messages, ctx)
    }
  }
}

/**
 * Call agent with conversation history and save messages.
 * Exported so command handlers (commands/*.ts) can reuse it.
 */
export async function callAgentWithHistory(
  agent: ReturnType<typeof registry.findAgent>,
  sessionId: string,
  prompt: string,
  history: ChatMessage[],
  ctx: RouteContext
): Promise<AsyncGenerator<string>> {
  await sessionManager.addMessage(ctx.platform, ctx.channelId, ctx.threadId, {
    role: 'user',
    content: prompt,
    timestamp: new Date()
  })

  const startTime = Date.now()
  ctx.logger.info({ event: 'agent.invoke.start', agent: agent!.name, promptLen: prompt.length, historyLen: history.length })

  const generator = agent!.sendPrompt(sessionId, prompt, history)

  return (async function* (): AsyncGenerator<string> {
    let fullResponse = ''
    let invocationError: string | undefined
    try {
      for await (const chunk of generator) {
        fullResponse += chunk
        yield chunk
      }
    } catch (err) {
      invocationError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      const durationMs = Date.now() - startTime
      if (fullResponse.trim()) {
        await sessionManager.addMessage(ctx.platform, ctx.channelId, ctx.threadId, {
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date()
        })
      }
      ctx.logger.info({
        event: 'agent.invoke.end',
        agent: agent!.name,
        durationMs,
        responseLen: fullResponse.length,
      })

      // Write audit record + update circuit breaker
      logInvocation({
        traceId: ctx.traceId,
        userId: ctx.userId || 'unknown',
        platform: ctx.platform,
        agent: agent!.name,
        intent: 'default',
        promptLen: prompt.length,
        responseLen: fullResponse.length,
        durationMs,
        cost: 0,
        success: !invocationError,
        error: invocationError,
      })

      if (invocationError) {
        circuitBreaker.recordFailure(agent!.name)
      } else {
        circuitBreaker.recordSuccess(agent!.name)
      }
    }
  })()
}
