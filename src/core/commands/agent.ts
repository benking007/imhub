// Agent commands: /test /review /commit /push /diff /shell /bug /explain
// These are forwarded to the active agent with the command prefix

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { isAgentAvailableCached, formatAgentNotAvailableError } from '../onboarding.js'
import { callAgentWithHistory } from '../router.js'

export async function handleAgentCommand(
  command: string,
  prompt: string,
  ctx: RouteContext
): Promise<string | ReturnType<typeof callAgentWithHistory>> {
  const existingSession = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  const agentName = existingSession?.agent || ctx.defaultAgent

  const agent = registry.findAgent(agentName)
  if (!agent) {
    return `❌ Agent "${agentName}" not found. Use /agents to see available agents.`
  }

  if (!(await isAgentAvailableCached(agent.name))) {
    return formatAgentNotAvailableError(agent.name)
  }

  const fullPrompt = `/${command} ${prompt}`.trim()

  const session = await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId, agent.name
  )
  return callAgentWithHistory(agent, session.id, fullPrompt, session.messages, ctx, session.model, session.variant)
}
