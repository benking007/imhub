// ACPAdapter — bridges ACP protocol to IM-Hub's AgentAdapter interface.
//
// P2-C: sessionId is now forwarded to the remote agent in the request body
// (as `session_id`) so multi-turn conversations preserve context across
// HTTP calls. Remote agents that don't recognize the field simply ignore
// it; this is a forward-compatible spec extension.

import type { AgentAdapter, ChatMessage } from '../../../core/types.js'
import type { ACPAgentConfig, ACPManifest } from './types.js'
import { ACPClient } from './acp-client.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'acp-adapter' })

export class ACPAdapter implements AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  private client: ACPClient

  constructor(config: ACPAgentConfig) {
    this.name = config.name
    this.aliases = config.aliases || []
    this.client = new ACPClient(config)
  }

  async isAvailable(): Promise<boolean> {
    return this.client.healthCheck()
  }

  async *sendPrompt(sessionId: string, prompt: string, history?: ChatMessage[]): AsyncGenerator<string> {
    // Try streaming first, fall back to sync.
    // NOTE: Fallback creates a new task; if the streaming task was partially
    // processed, the agent may repeat work. Acceptable for v1.
    try {
      for await (const chunk of this.client.streamPrompt(prompt, history, sessionId)) {
        yield chunk
      }
    } catch (streamError) {
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError)
      log.warn({ agent: this.name, error: errMsg, sessionId },
        'ACP streaming failed, falling back to sync')
      const response = await this.client.sendPromptSync(prompt, history, sessionId)
      if (response) yield response
    }
  }

  /** Get the agent manifest for display (not part of AgentAdapter interface) */
  async getManifest(): Promise<ACPManifest | undefined> {
    try {
      return await this.client.fetchManifest()
    } catch {
      return undefined
    }
  }
}
