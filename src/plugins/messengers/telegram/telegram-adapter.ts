// Telegram Bot API Adapter using grammy
// Implements MessengerAdapter interface with native typing indicator support

import { Bot, Context } from 'grammy'
import type {
  MessengerAdapter,
  MessageContext,
  Message,
  ButtonCallback,
  ApprovalCardPrompt,
  ApprovalCardOutcome,
} from '../../../core/types.js'
import type { TelegramConfig } from './types.js'
import { markdownToTelegramHtml } from './markdown-to-html.js'
import { splitMessage } from '../../../utils/message-split.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'telegram' })

export class TelegramAdapter implements MessengerAdapter {
  readonly name = 'telegram'
  private bot: Bot | null = null
  private config: TelegramConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private buttonHandler?: (cb: ButtonCallback) => Promise<void>
  private isRunning = false
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
  // grammy 的 bot.start() 长轮询偶尔会被一次网络抖动 wedge —— 既不报错也不
  // resolve，看起来还在跑但不再 fetch updates，TG 那边 pending_update_count
  // 一路涨。watchdog 周期性 ping getMe；连续多次失败就强制 stop+start，让
  // 卡死的 polling loop 重置。
  private watchdogTimer?: ReturnType<typeof setInterval>
  private consecutivePingFailures = 0
  private static readonly WATCHDOG_INTERVAL_MS = 60_000
  private static readonly WATCHDOG_FAILURE_THRESHOLD = 3 // ~3min 无响应就重启 polling

  async start(): Promise<void> {
    // Load config
    const { readFile } = await import('fs/promises')
    const { homedir } = await import('os')
    const { join } = await import('path')

    const configPath = join(homedir(), '.im-hub', 'config.json')
    try {
      const data = await readFile(configPath, 'utf-8')
      const config = JSON.parse(data)
      this.config = config.telegram as TelegramConfig
    } catch {
      throw new Error('Telegram config not found. Run "im-hub config telegram" first.')
    }

    if (!this.config?.botToken) {
      throw new Error('Telegram bot token not configured. Run "im-hub config telegram" first.')
    }

    // Initialize bot
    this.bot = new Bot(this.config.botToken)

    // Set up message handler.
    //
    // CRITICAL: do NOT await messageHandler here. grammy processes updates
    // sequentially per chat — if the handler awaits an agent run that's
    // waiting on a separate IM-side approval reply, polling stalls and the
    // user's approval reply piles up in TG's pending_update_count, never
    // reaching us. Fire-and-forget mirrors how the WeChat ilink adapter
    // dispatches (ilink-adapter.ts:258).
    this.bot.on('message:text', (ctx) => {
      // Ignore messages from bots
      if (ctx.message.from.is_bot) return
      if (!this.messageHandler) return

      const message: Message = {
        id: ctx.message.message_id.toString(),
        threadId: ctx.chat.id.toString(),
        userId: ctx.message.from?.id?.toString() || 'unknown',
        text: ctx.message.text || '',
        timestamp: new Date(ctx.message.date * 1000),
        channelId: this.config?.channelId || 'default',
      }
      const msgCtx: MessageContext = {
        message,
        platform: 'telegram',
        channelId: this.config?.channelId || 'default',
      }

      this.messageHandler(msgCtx).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        log.error({ err: errMsg, stack, threadId: message.threadId }, 'Error in message handler')
      })
    })

    // Inline-button taps (approval cards). Same fire-and-forget discipline
    // as message:text — buttonHandler may resolve a pending approval which
    // calls back into editApprovalCard; we don't want that to block grammy's
    // sequential update queue.
    //
    // Telegram requires answerCallbackQuery within ~1s or the client shows
    // a spinner. We wrap ack() so the handler can call it explicitly when
    // it has a meaningful toast; if it doesn't, we send an empty ack at the
    // end as a safety net (idempotent — TG ignores the second call).
    this.bot.on('callback_query:data', (ctx) => {
      if (!this.buttonHandler) {
        void ctx.answerCallbackQuery({ text: '系统未就绪' }).catch(() => {})
        return
      }
      const data = ctx.callbackQuery.data
      const from = ctx.callbackQuery.from
      const msg = ctx.callbackQuery.message
      if (!msg) {
        void ctx.answerCallbackQuery({ text: '消息已不可用' }).catch(() => {})
        return
      }

      // Optional allowlist gate. Empty / missing list = allow anyone (matches
      // the text-reply path). When configured, refuse with a toast — the
      // refusal does NOT resolve the pending, so an authorized user can
      // still click later.
      const allowlist = this.config?.approvalAllowlist
      if (allowlist && allowlist.length > 0) {
        const fromIdStr = from.id.toString()
        if (!allowlist.includes(fromIdStr)) {
          log.warn({
            event: 'telegram.approval.unauthorized_click',
            userId: fromIdStr,
            username: from.username,
            chatType: msg.chat.type,
            chatId: msg.chat.id,
          }, 'Unauthorized button click rejected by allowlist')
          void ctx.answerCallbackQuery({ text: '无权审批此请求' }).catch(() => {})
          return
        }
      }
      let acked = false
      const cb: ButtonCallback = {
        data,
        threadId: msg.chat.id.toString(),
        userId: from.id.toString(),
        userDisplay: from.username ? `@${from.username}` : (from.first_name || from.id.toString()),
        messageId: msg.message_id.toString(),
        ack: async (text?: string) => {
          if (acked) return
          acked = true
          try {
            await ctx.answerCallbackQuery(text ? { text } : undefined)
          } catch (err) {
            log.warn({ err: String(err) }, 'answerCallbackQuery failed')
          }
        },
      }
      this.buttonHandler(cb)
        .catch((err) => {
          log.error({ err: String(err), data }, 'Error in button handler')
        })
        .finally(() => {
          if (!acked) {
            // Safety net so the user's TG client doesn't keep spinning when
            // the handler forgot to ack.
            void ctx.answerCallbackQuery().catch(() => {})
          }
        })
    })

    // Start bot in background. grammy's start() uses long polling and resolves
    // only when polling stops. We wrap it in a self-healing loop so that:
    //   1. an unexpected resolve while still isRunning → restart polling
    //   2. a thrown error → log it and retry after a short backoff
    // Combined with the watchdog (below), this defends against the silent
    // wedge mode where bot.start() neither resolves nor rejects but stops
    // fetching updates.
    log.info('Starting bot with long polling')
    this.isRunning = true
    void this.runPollingLoop()
    this.startWatchdog()
    log.info('Telegram adapter started')
  }

  private async runPollingLoop(): Promise<void> {
    while (this.isRunning && this.bot) {
      try {
        await this.bot.start()
        if (this.isRunning) {
          log.warn({ event: 'telegram.polling.unexpected_stop' },
            'bot.start() resolved while still running; restarting in 2s')
          await new Promise((r) => setTimeout(r, 2000))
        } else {
          log.info('Bot stopped gracefully')
          return
        }
      } catch (err) {
        if (!this.isRunning) return
        log.error(
          { err: err instanceof Error ? err.message : String(err), event: 'telegram.polling.error' },
          'Bot polling error; restarting in 5s')
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.consecutivePingFailures = 0
    this.watchdogTimer = setInterval(async () => {
      if (!this.isRunning || !this.bot) return
      try {
        await this.bot.api.getMe()
        if (this.consecutivePingFailures > 0) {
          log.info({ event: 'telegram.watchdog.recovered' }, 'getMe ping recovered')
        }
        this.consecutivePingFailures = 0
      } catch (err) {
        this.consecutivePingFailures += 1
        log.warn({
          event: 'telegram.watchdog.ping_failed',
          consecutive: this.consecutivePingFailures,
          err: err instanceof Error ? err.message : String(err),
        }, 'Watchdog getMe ping failed')
        if (this.consecutivePingFailures >= TelegramAdapter.WATCHDOG_FAILURE_THRESHOLD) {
          log.error({ event: 'telegram.watchdog.restarting_polling' },
            'Polling appears wedged; forcing bot.stop() to trigger restart')
          this.consecutivePingFailures = 0
          try { await this.bot.stop() } catch { /* ignore */ }
          // runPollingLoop will see bot.start() resolve and restart it.
        }
      }
    }, TelegramAdapter.WATCHDOG_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.isRunning = false

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }

    // Clean up all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()

    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }

    log.info('Telegram adapter stopped')
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram adapter not started')
    }

    const htmlText = markdownToTelegramHtml(text)
    const chunks = splitMessage(htmlText, { maxLength: 4000, addContinuationMarker: false })

    for (const chunk of chunks) {
      await this.bot.api.sendMessage(threadId, chunk, { parse_mode: 'HTML' })
    }
  }

  onButtonCallback(handler: (cb: ButtonCallback) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendApprovalCard(
    threadId: string,
    prompt: ApprovalCardPrompt,
  ): Promise<{ messageId: string }> {
    if (!this.bot) throw new Error('Telegram adapter not started')
    const text = renderApprovalCardHtml(prompt)
    const reply_markup = renderApprovalKeyboard(prompt)
    const sent = await this.bot.api.sendMessage(threadId, text, {
      parse_mode: 'HTML',
      reply_markup,
    })
    return { messageId: sent.message_id.toString() }
  }

  async editApprovalCard(
    threadId: string,
    messageId: string,
    outcome: ApprovalCardOutcome,
  ): Promise<void> {
    if (!this.bot) return
    const numericId = Number.parseInt(messageId, 10)
    if (!Number.isFinite(numericId)) {
      log.warn({ messageId }, 'editApprovalCard: non-numeric messageId')
      return
    }
    const text = renderApprovalOutcomeHtml(outcome)
    try {
      await this.bot.api.editMessageText(threadId, numericId, text, {
        parse_mode: 'HTML',
        // Omit reply_markup → buttons stay. We want to drop them, so pass
        // an empty inline_keyboard to clear.
        reply_markup: { inline_keyboard: [] },
      })
    } catch (err) {
      // Common: "message is not modified", "message can't be edited" (>48h),
      // "message to edit not found". All non-fatal — bus already resolved.
      log.warn({ err: String(err), messageId }, 'editApprovalCard failed (non-fatal)')
    }
  }

  async sendTyping(threadId: string, isTyping: boolean): Promise<void> {
    if (!this.bot) {
      return
    }

    if (isTyping) {
      // Send initial typing action
      try {
        await this.bot.api.sendChatAction(threadId, 'typing')
      } catch {
        // Ignore errors during typing
      }

      // Clear any existing interval
      const existing = this.typingIntervals.get(threadId)
      if (existing) {
        clearInterval(existing)
      }

      // Set up periodic refresh every 4 seconds (Telegram expires after ~5s)
      const interval = setInterval(async () => {
        try {
          await this.bot!.api.sendChatAction(threadId, 'typing')
        } catch {
          // Ignore errors during typing refresh
        }
      }, 4000)

      this.typingIntervals.set(threadId, interval)
    } else {
      // Clear the refresh interval
      const interval = this.typingIntervals.get(threadId)
      if (interval) {
        clearInterval(interval)
        this.typingIntervals.delete(threadId)
      }
      // Note: Telegram has no "cancel" action - typing just expires
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatHm(d: Date): string {
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

function renderApprovalCardHtml(p: ApprovalCardPrompt): string {
  const tool = escapeHtml(p.toolName)
  const input = escapeHtml(p.inputJson)
  const reqShort = escapeHtml(p.reqId.slice(0, 8))
  if (p.mode === 'auto-allow') {
    const sec = p.graceSeconds ?? 5
    return [
      `⏱ <b>自动放行中</b>（${sec}s 后执行）`,
      `工具：<b>${tool}</b>`,
      `入参：<pre>${input}</pre>`,
      `点 ❌ 拒绝可同时撤销该工具的自动放行规则`,
      `<i>req: ${reqShort}</i>`,
    ].join('\n')
  }
  return [
    `🔐 <b>工具调用审批</b>`,
    `工具：<b>${tool}</b>`,
    `入参：<pre>${input}</pre>`,
    `<i>req: ${reqShort}</i>`,
  ].join('\n')
}

function renderApprovalKeyboard(p: ApprovalCardPrompt): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  const r = p.reqId
  if (p.mode === 'auto-allow') {
    return {
      inline_keyboard: [[
        { text: '❌ 拒绝（撤销规则）', callback_data: `apv:${r}:n` },
      ]],
    }
  }
  return {
    inline_keyboard: [
      [
        { text: '✅ 同意', callback_data: `apv:${r}:y` },
        { text: '❌ 拒绝', callback_data: `apv:${r}:n` },
      ],
      [
        { text: '🛡 本会话自动放行同类', callback_data: `apv:${r}:a` },
      ],
    ],
  }
}

function renderApprovalOutcomeHtml(o: ApprovalCardOutcome): string {
  const t = formatHm(o.atDate)
  const by = o.byUserDisplay ? ` · by ${escapeHtml(o.byUserDisplay)}` : ''
  switch (o.decision) {
    case 'allowed':         return `✅ <b>已批准</b> · ${t}${by}`
    case 'allowed-pinned':  return `🛡 <b>已批准并加入自动放行</b> · ${t}${by}`
    case 'denied':          return `❌ <b>已拒绝</b> · ${t}${by}`
    case 'denied-revoked':  return `❌ <b>已拒绝并撤销自动放行</b> · ${t}${by}`
    case 'expired':         return `⏱ <b>已过期</b> · ${t}`
  }
}

export const telegramAdapter = new TelegramAdapter()
