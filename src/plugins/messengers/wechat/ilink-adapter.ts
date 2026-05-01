// WeChat iLink Bot API Adapter
// Implements MessengerAdapter using the iLink HTTP API

import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { ILinkClient } from './ilink-client.js'
import type { Credentials, WeixinMessage, ContextTokenCache } from './ilink-types.js'
import { ILINK_ERRORS } from './ilink-types.js'
import { homedir } from 'os'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'wechat-ilink' })

const CREDENTIALS_FILE = join(homedir(), '.im-hub', 'wechat-credentials.json')
const POLL_TIMEOUT = 30000 // 30 seconds
const CONTEXT_TOKEN_TTL = 30 * 60 * 1000 // 30 minutes

const PROCESSED_MESSAGES_TTL = 60 * 1000 // 1 minute

export class ILinkWeChatAdapter implements MessengerAdapter {
  readonly name = 'wechat-ilink'
  private client: ILinkClient
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private isRunning = false
  private pollState = {
    getUpdatesBuf: '',
    isPolling: false,
    lastPollTime: 0,
  }
  private contextTokens = new Map<string, ContextTokenCache>()
  private typingTickets = new Map<string, string>()
  private processedMessages = new Map<string, number>() // message_id -> timestamp

  constructor() {
    this.client = new ILinkClient()
  }

  // ============================================
  // Lifecycle
  // ============================================

  async start(): Promise<void> {
    // Load saved credentials
    const credentials = await this.loadCredentials()
    if (credentials) {
      this.client.setCredentials(credentials)
      log.info('Credentials loaded from cache')
    } else {
      throw new Error('No WeChat credentials found. Run "im-hub config wechat" first.')
    }

    this.isRunning = true
    log.info('WeChat iLink adapter started')

    // Start polling in background
    this.startPolling()
  }

  async stop(): Promise<void> {
    this.isRunning = false
    this.client.clearCredentials()
    log.info('WeChat iLink adapter stopped')
  }

  // ============================================
  // Message Handling
  // ============================================

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.client.hasCredentials()) {
      throw new Error('WeChat adapter not authenticated')
    }

    // Extract user ID from threadId (format: user:xxx or room:xxx)
    const userId = threadId.replace(/^(user|room):/, '')

    // Get context token for this user
    const contextToken = this.getContextToken(userId)
    if (!contextToken) {
      throw new Error('No context token available for this user')
    }

    // Split long messages
    const chunks = this.splitMessage(text)

    for (const chunk of chunks) {
      const response = await this.client.sendMessage(userId, chunk, contextToken)

      if (response.ret !== 0 && response.ret !== undefined) {
        if (response.ret === ILINK_ERRORS.SESSION_EXPIRED) {
          throw new Error('WeChat session expired. Please re-login.')
        }
        throw new Error(`Failed to send message: ${response.errmsg || response.ret}`)
      }
    }
  }

  // ============================================
  // Typing Indicator
  // ============================================

  /**
   * Send a "thinking" placeholder. iLink doesn't expose a server-side message
   * recall API, so the placeholder lingers in the chat after the real
   * response arrives — but at least the user gets immediate feedback that
   * the bot received their message and is working on it.
   */
  async sendThinking(threadId: string, text: string): Promise<undefined> {
    try {
      await this.sendMessage(threadId, text)
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to send thinking placeholder')
    }
    return undefined  // no dismiss — recall not supported on iLink
  }

  async sendTyping(threadId: string, isTyping: boolean): Promise<void> {
    if (!this.client.hasCredentials()) {
      return
    }

    // Extract user ID from threadId (format: user:xxx or room:xxx)
    const userId = threadId.replace(/^(user|room):/, '')

    // Get or fetch typing ticket
    let typingTicket: string | undefined = this.typingTickets.get(userId)
    if (!typingTicket) {
      const contextToken = this.getContextToken(userId)
      const ticket = await this.client.getTypingTicket(userId, contextToken ?? undefined)
      if (!ticket) {
        log.warn({ userId }, 'Could not get typing ticket')
        return
      }
      typingTicket = ticket
      this.typingTickets.set(userId, ticket)
    }

    // Send typing status (1 = start, 2 = stop)
    const status = isTyping ? 1 : 2
    const success = await this.client.sendTyping(userId, typingTicket, status)

    if (!success) {
      // Ticket might be expired, clear it for next attempt
      this.typingTickets.delete(userId)
      log.warn({ userId }, 'Failed to send typing indicator, cleared ticket')
    }
  }

  // ============================================
  // QR Code Login
  // ============================================

  /**
   * Start QR code login flow
   * Returns QR code URL and token for polling
   */
  async startQRLogin(): Promise<{ qrUrl: string; qrToken: string }> {
    const response = await this.client.getQRCode()
    return {
      qrUrl: response.qrcode_img_content,
      qrToken: response.qrcode,
    }
  }

  /**
   * Poll QR code status until confirmed or expired
   */
  async waitForQRLogin(
    qrToken: string,
    onStatus?: (status: string) => void
  ): Promise<Credentials | null> {
    const maxAttempts = 120 // 2 minutes with 1s interval
    let attempts = 0

    while (attempts < maxAttempts) {
      const status = await this.client.getQRCodeStatus(qrToken)

      switch (status.status) {
        case 'wait':
          onStatus?.('Waiting for scan...')
          break

        case 'scaned':
          onStatus?.('QR code scanned! Waiting for confirmation...')
          break

        case 'confirmed':
          if (status.bot_token && status.ilink_bot_id && status.ilink_user_id) {
            const credentials: Credentials = {
              bot_token: status.bot_token,
              baseUrl: status.baseurl || 'https://ilinkai.weixin.qq.com',
              accountId: status.ilink_bot_id,
              userId: status.ilink_user_id,
              savedAt: new Date().toISOString(),
            }

            // Save credentials
            await this.saveCredentials(credentials)
            this.client.setCredentials(credentials)

            onStatus?.('Login successful!')
            return credentials
          }
          break

        case 'expired':
          onStatus?.('QR code expired')
          return null
      }

      // Wait 1 second before next poll
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }

    return null
  }

  // ============================================
  // Polling
  // ============================================

  private startPolling(): void {
    if (this.pollState.isPolling) return

    this.pollState.isPolling = true
    this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    log.info('Polling started')
    let consecutiveFailures = 0
    let lastHeartbeatTime = Date.now()
    const HEARTBEAT_INTERVAL_MS = 60 * 1000 // 60 seconds

    while (this.isRunning) {
      try {
        const response = await this.client.getUpdates(this.pollState.getUpdatesBuf)

        // Success — reset failure counter
        consecutiveFailures = 0

        if (response.msgs?.length) {
          log.debug({ count: response.msgs.length }, 'Received messages')
        }

        const isSuccess = response.ret === 0 || response.ret === undefined
        if (isSuccess) {
          this.pollState.getUpdatesBuf = response.get_updates_buf

          if (response.msgs) {
            for (const msg of response.msgs) {
              this.handleIncomingMessage(msg).catch(err =>
                log.error({ err: err instanceof Error ? err.message : String(err) }, 'Message handler error')
              )
            }
          }
        } else if (response.ret === ILINK_ERRORS.SESSION_EXPIRED) {
          log.warn('WeChat session expired, attempting recovery...')
          const recovered = await this.tryRefreshSession()
          if (!recovered) {
            log.error('WeChat session expired. Token refresh failed after retries — polling stopped.')
            this.isRunning = false
            break
          }
          log.info('Token refreshed successfully, resuming polling')
        } else {
          log.warn({ ret: response.ret }, 'Unexpected getUpdates response code')
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        consecutiveFailures++
        log.error({ err: errMsg, consecutiveFailures }, 'Poll error')

        // Exponential backoff on consecutive failures.
        //   1st failure: no extra wait, just the regular 1s tail sleep
        //   2nd: 2s   3rd: 4s   4th: 8s   5th: 16s   6th+: 30s (capped)
        if (consecutiveFailures > 1) {
          const delay = Math.min(1000 * Math.pow(2, consecutiveFailures - 1), 30000)
          log.warn({ delayMs: delay }, `Backing off after ${consecutiveFailures} consecutive failures`)
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
      }

      // Periodic heartbeat: getconfig probe (no side effect on the
      // long-poll cursor, so it's safe to run alongside the loop).
      if (Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatTime = Date.now()
        this.sendHeartbeat().catch(err =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Heartbeat error')
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    this.pollState.isPolling = false
    log.info('Polling stopped')
  }

  /**
   * Attempt to recover from SESSION_EXPIRED. Tries a fresh getUpdates
   * up to 3 times with linear backoff so a single network blip during
   * recovery doesn't tear down the whole adapter (W-3).
   */
  private async tryRefreshSession(): Promise<boolean> {
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.getUpdates('')
        if (response.ret === 0 || response.ret === undefined) {
          this.pollState.getUpdatesBuf = response.get_updates_buf
          if (response.msgs) {
            for (const msg of response.msgs) {
              if (msg.from_user_id && msg.context_token) {
                this.setContextToken(msg.from_user_id, msg.context_token)
              }
            }
          }
          log.info({ attempt }, 'Session recovered after SESSION_EXPIRED')
          return true
        }
        log.warn({ attempt, ret: response.ret }, 'Session refresh attempt returned error')
      } catch (err) {
        log.warn({ attempt, err: err instanceof Error ? err.message : String(err) },
          'Session refresh attempt threw')
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))  // 5s, 10s
      }
    }
    return false
  }

  /**
   * Periodic keep-alive: probe getconfig instead of getUpdates so we don't
   * race the polling loop on the same long-poll cursor (W-1).
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.client.hasCredentials()) return
    const ok = await this.client.pingConfig()
    if (ok) {
      log.debug('Heartbeat OK')
    } else {
      log.warn('Heartbeat failed (getconfig returned non-OK)')
    }
  }

  private async handleIncomingMessage(msg: WeixinMessage): Promise<void> {
    log.debug({ messageId: msg.message_id, type: msg.message_type }, 'handleIncomingMessage')

    if (!this.messageHandler) {
      log.warn('No message handler registered')
      return
    }

    if (msg.message_type === 2) {
      log.debug('Skipping bot message')
      return
    }

    const msgId = String(msg.message_id)
    if (msgId && this.processedMessages.has(msgId)) {
      log.debug({ messageId: msgId }, 'Skipping duplicate message')
      return
    }

    if (msgId) {
      this.processedMessages.set(msgId, Date.now())
      this.cleanupProcessedMessages()
    }

    if (!msg.item_list?.length) {
      log.debug('No item_list in message')
      return
    }

    const textItems = msg.item_list.filter((item) => item.type === 1 && item.text_item?.text)
    if (!textItems.length) {
      log.debug('No text items found')
      return
    }

    const text = textItems.map((item) => item.text_item!.text).join('\n')
    log.debug({
      text,
      fromUserId: msg.from_user_id,
      contextToken: msg.context_token ? 'present' : 'missing',
    }, 'Extracted message')

    // Store context token for replies
    if (msg.from_user_id && msg.context_token) {
      this.setContextToken(msg.from_user_id, msg.context_token)
    }

    // Build message object - use accountId as channelId
    const message: Message = {
      id: String(msg.message_id || Date.now()),
      threadId: msg.group_id ? `room:${msg.group_id}` : `user:${msg.from_user_id}`,
      userId: msg.from_user_id || 'unknown',
      text,
      timestamp: new Date(msg.create_time_ms || Date.now()),
      channelId: this.client.getCredentials()?.accountId || 'default',
    }

    const ctx: MessageContext = {
      message,
      platform: 'wechat',
      channelId: this.client.getCredentials()?.accountId || 'default',
    }

    log.debug('Calling message handler')
    await this.messageHandler(ctx)
    log.debug('Message handler completed')
  }

  // ============================================
  // Context Token Management
  // ============================================

  private getContextToken(userId: string): string | null {
    const cached = this.contextTokens.get(userId)
    if (!cached) return null

    // Check if expired
    if (Date.now() - cached.timestamp > CONTEXT_TOKEN_TTL) {
      this.contextTokens.delete(userId)
      return null
    }

    return cached.contextToken
  }

  private setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, {
      userId,
      contextToken: token,
      timestamp: Date.now(),
    })
  }

  private cleanupProcessedMessages(): void {
    const now = Date.now()
    for (const [msgId, timestamp] of this.processedMessages) {
      if (now - timestamp > PROCESSED_MESSAGES_TTL) {
        this.processedMessages.delete(msgId)
      }
    }
  }

  // ============================================
  // Credentials Persistence
  // ============================================

  private async loadCredentials(): Promise<Credentials | null> {
    try {
      const data = await readFile(CREDENTIALS_FILE, 'utf-8')
      return JSON.parse(data) as Credentials
    } catch {
      return null
    }
  }

  private async saveCredentials(credentials: Credentials): Promise<void> {
    const dir = join(CREDENTIALS_FILE, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2))
    log.info({ file: CREDENTIALS_FILE }, 'Credentials saved')
  }

  // ============================================
  // Utilities
  // ============================================

  private splitMessage(text: string, maxLength = 2000): string[] {
    if (text.length <= maxLength) {
      return [text]
    }

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > maxLength) {
      // Try to split at newline
      let splitPoint = remaining.lastIndexOf('\n', maxLength)
      if (splitPoint < maxLength / 2) {
        splitPoint = maxLength
      }

      chunks.push(remaining.slice(0, splitPoint))
      remaining = remaining.slice(splitPoint).trim()
    }

    if (remaining) {
      chunks.push(remaining)
    }

    // Add continuation markers
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length - 1; i++) {
        chunks[i] += '\n\n[continued...]'
      }
    }

    return chunks
  }
}

// Singleton instance
export const ilinkWeChatAdapter = new ILinkWeChatAdapter()
