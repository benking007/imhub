// Feishu/Lark Bot API Adapter using official SDK with WebSocket long polling
// Implements MessengerAdapter interface with// https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/preparation-before-development

import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { FeishuClient } from './feishu-client.js'
import { CardBuilder } from './card-builder.js'
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

export class FeishuAdapter implements MessengerAdapter {
  readonly name = 'feishu'
  private client: FeishuClient | null = null
  private config: FeishuConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private isRunning = false

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

    // Use card for better formatting
    const card = new CardBuilder()
      .addMarkdown(text)
      .build()

    await this.client.sendCard(threadId, card)
  }

  async sendCard(threadId: string, card: unknown): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu adapter not started')
    }
    await this.client.sendCard(threadId, card)
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
