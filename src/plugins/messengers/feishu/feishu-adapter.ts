// Feishu/Lark Bot API Adapter using official SDK with WebSocket long polling
// Implements MessengerAdapter interface with// https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/preparation-before-development

import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { FeishuClient } from './feishu-client.js'
import type { FeishuConfig } from './types.js'
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'feishu' })

const CONFIG_FILE = join(homedir(), '.im-hub', 'config.json')

// Message event type from Feishu SDK
interface MessageReceiveEvent {
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    chat_id: string
    message_type: string
    content: string
    create_time: string
  }
  sender: {
    sender_id?: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
    sender_type: string
    tenant_key: string
  }
}

// Feishu's WebSocket long-poll replays message events on reconnect, so the
// same message_id can hit handleFeishuMessage multiple times. Dedup with a
// time-bounded set: messages older than DEDUP_TTL_MS expire automatically,
// and we cap entries at DEDUP_MAX to bound memory.
const DEDUP_TTL_MS = 10 * 60 * 1000
const DEDUP_MAX = 2000

export class FeishuAdapter implements MessengerAdapter {
  readonly name = 'feishu'
  private client: FeishuClient | null = null
  private config: FeishuConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private isRunning = false
  /** message_id → first-seen timestamp (ms). LRU-ish: pruned on insert. */
  private seenMessages = new Map<string, number>()

  async start(): Promise<void> {
    // Load config
    try {
      const data = await readFile(CONFIG_FILE, 'utf-8')
      const fullConfig = JSON.parse(data)
      this.config = fullConfig.feishu as FeishuConfig
    } catch {
      throw new Error('Feishu config not found. Run "im-hub config feishu" first.')
    }

    if (!this.config?.appId || !this.config?.appSecret) {
      throw new Error('Feishu App ID or Secret not configured. Run "im-hub config feishu" first.')
    }

    // Initialize client with WebSocket long polling
    this.client = new FeishuClient(this.config)

    // Set up message handler using official SDK event
    this.client.onMessage(async (event: MessageReceiveEvent) => {
      await this.handleFeishuMessage(event)
    })

    // Start WebSocket long polling
    await this.client.start()

    this.isRunning = true
    log.info('Feishu adapter started (WebSocket long polling mode, no webhook needed)')
  }

  async stop(): Promise<void> {
    this.isRunning = false

    if (this.client) {
      await this.client.stop()
    }

    log.info('Feishu adapter stopped')
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu adapter not started')
    }
    // Plain text — cards are reserved for cli's explicit sendCard call site
    // (long markdown agent responses with agent badge). Wrapping every short
    // message (approval prompts, system replies, errors) as a card was making
    // every bubble look like a notification, indistinguishable from real
    // approval-required cards.
    await this.client.sendMessage(threadId, text)
  }

  async sendCard(threadId: string, card: unknown): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu adapter not started')
    }
    await this.client.sendCard(threadId, card)
  }

  async sendThinking(
    threadId: string,
    text: string,
  ): Promise<(() => Promise<void>) | undefined> {
    if (!this.client) return undefined
    try {
      const resp = await this.client.sendMessage(threadId, text)
      const messageId = resp.message_id
      if (!messageId) return undefined
      return async () => {
        try {
          await this.client!.deleteMessage(messageId)
        } catch (err) {
          log.debug({ err: String(err), messageId }, 'Failed to recall thinking placeholder')
        }
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to send thinking placeholder')
      return undefined
    }
  }

  async sendTyping(threadId: string, isTyping: boolean): Promise<void> {
    if (!this.client) {
      return
    }
    // Note: The typing indicator is handled by Feishu's built-in UI
    // when a message is being processed. No explicit API call needed.
    if (isTyping) {
      log.debug({ threadId }, 'Processing message')
    }
  }

  // ============================================
  // Event Handling
  // ============================================

  /**
   * Returns true if this message_id was already seen within DEDUP_TTL_MS.
   * Side effect on first sight: record it and prune any expired entries.
   */
  private isDuplicate(messageId: string): boolean {
    const now = Date.now()
    const seenAt = this.seenMessages.get(messageId)
    if (seenAt !== undefined && now - seenAt < DEDUP_TTL_MS) {
      return true
    }
    // First sight (or expired) — record and prune.
    this.seenMessages.set(messageId, now)
    if (this.seenMessages.size > DEDUP_MAX) {
      // Walk in insertion order (Map preserves it) and drop expired or oldest.
      const cutoff = now - DEDUP_TTL_MS
      for (const [k, t] of this.seenMessages) {
        if (t < cutoff) this.seenMessages.delete(k)
        if (this.seenMessages.size <= DEDUP_MAX * 0.8) break
      }
      // If still over (no expirations), drop the oldest until under cap.
      while (this.seenMessages.size > DEDUP_MAX) {
        const oldest = this.seenMessages.keys().next().value
        if (!oldest) break
        this.seenMessages.delete(oldest)
      }
    }
    return false
  }

  private async handleFeishuMessage(event: MessageReceiveEvent): Promise<void> {
    log.debug('Received message event')

    if (!this.messageHandler) {
      log.debug('No message handler registered')
      return
    }

    const sender = event.sender
    const message = event.message

    if (sender.sender_type === 'app') {
      log.debug('Ignoring bot message')
      return
    }

    // Dedup replayed events — same message_id within DEDUP_TTL_MS is a no-op.
    const msgId = message.message_id || ''
    if (msgId && this.isDuplicate(msgId)) {
      log.info({ messageId: msgId, event: 'feishu.dedup.skip' }, 'Dropping replayed message_id')
      return
    }

    let text = ''
    try {
      const content = JSON.parse(message.content || '{}')
      text = content.text || ''
    } catch {
      log.warn({ messageId: message.message_id }, 'Failed to parse message content')
      return
    }

    if (!text) {
      log.debug('Empty message text')
      return
    }

    log.debug({ text }, 'Message received')

    const msg: Message = {
      id: message.message_id || '',
      threadId: message.chat_id || '',
      userId: sender.sender_id?.open_id || sender.sender_id?.user_id || 'unknown',
      text,
      timestamp: new Date(parseInt(message.create_time || '0')),
      channelId: this.config?.channelId || 'default',
    }

    const ctx: MessageContext = {
      message: msg,
      platform: 'feishu',
      channelId: this.config?.channelId || 'default',
    }

    try {
      await this.messageHandler(ctx)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      log.error({ err: errMsg, stack }, 'Error in message handler')
    }
  }
}

// Singleton instance
export const feishuAdapter = new FeishuAdapter()
