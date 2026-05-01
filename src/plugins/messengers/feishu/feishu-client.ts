// Feishu Bot API Client using official SDK with WebSocket long polling
// https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/preparation-before-development

import * as Lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './types.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'feishu-client' })

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

type MessageHandler = (event: MessageReceiveEvent) => Promise<void>

export class FeishuClient {
  private client: Lark.Client
  private wsClient: Lark.WSClient
  private config: FeishuConfig
  private eventDispatcher: Lark.EventDispatcher
  private messageHandler?: MessageHandler

  constructor(config: FeishuConfig) {
    this.config = config

    // Create base config
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    }

    // Initialize API client
    this.client = new Lark.Client(baseConfig)

    // Initialize event dispatcher
    this.eventDispatcher = new Lark.EventDispatcher({})

    // Initialize WebSocket client for long polling
    this.wsClient = new Lark.WSClient(baseConfig)
  }

  // ============================================
  // Event Registration
  // ============================================

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  // ============================================
  // API Calls
  // ============================================

  async sendMessage(chatId: string, text: string): Promise<{ message_id?: string }> {
    const response = await this.client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    return (response.data ?? {}) as { message_id?: string }
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.client.im.message.delete({
      path: { message_id: messageId },
    })
  }

  async sendCard(chatId: string, card: unknown): Promise<unknown> {
    const response = await this.client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return response.data
  }

  async replyToMessage(messageId: string, text: string): Promise<unknown> {
    const response = await this.client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    return response.data
  }

  async replyWithCard(messageId: string, card: unknown): Promise<unknown> {
    const response = await this.client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return response.data
  }

  // ============================================
  // WebSocket Long Polling
  // ============================================

  async start(): Promise<void> {
    // Register event handlers
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        if (this.messageHandler) {
          await this.messageHandler(data as MessageReceiveEvent)
        }
      },
    })

    // Start WebSocket long polling with event dispatcher
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    })
    log.info('WebSocket long polling started')
  }

  async stop(): Promise<void> {
    this.wsClient.close()
    log.info('WebSocket connection stopped')
  }

  // ============================================
  // Getters
  // ============================================

  get larkClient(): Lark.Client {
    return this.client
  }
}
