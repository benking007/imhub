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
import {
  cleanupOldMedia,
  downloadToMediaRoot,
  pickExtension,
} from './media-download.js'
import { splitMessage } from '../../../utils/message-split.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { transcribe, detectProvider, TranscribeError } from '../../../core/transcribe.js'

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
  private mediaCleanupTimer?: ReturnType<typeof setInterval>
  private static readonly MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000  // hourly

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

    // Media handlers — TG photos and image documents. We await the download
    // inside the handler (it's bounded; typical TG photo is < 1 s, hard cap
    // 20 MB) so the resulting Message reflects the image being on disk before
    // we kick off the agent. messageHandler itself is fire-and-forget for the
    // same reasons as message:text above. Order across photo / text within a
    // chat is preserved because grammy serializes updates per chat.
    this.bot.on('message:photo', (ctx) => {
      if (ctx.message.from?.is_bot) return
      if (!this.messageHandler) return
      // Largest size is the last entry — TG ships scaled-down siblings for
      // bandwidth-conscious clients which we ignore.
      const photo = ctx.message.photo[ctx.message.photo.length - 1]
      void this.handleMediaUpload(ctx, photo.file_id, undefined, ctx.message.caption ?? '')
    })

    this.bot.on('message:document', (ctx) => {
      if (ctx.message.from?.is_bot) return
      if (!this.messageHandler) return
      const doc = ctx.message.document
      // Image documents → media upload path. Audio documents → voice path.
      // Anything else gets dropped (videos / archives / misc).
      if (doc.mime_type?.startsWith('image/')) {
        void this.handleMediaUpload(ctx, doc.file_id, doc.mime_type, ctx.message.caption ?? '')
        return
      }
      if (doc.mime_type?.startsWith('audio/')) {
        // Document type has no `duration` field even when MIME is audio/*;
        // only message:voice / message:audio carry it. Pass undefined.
        void this.handleVoiceUpload(ctx, doc.file_id, doc.mime_type, ctx.message.caption ?? '', undefined)
        return
      }
      log.debug({ mime: doc.mime_type, chatId: ctx.chat.id }, 'ignoring non-image/audio document')
    })

    // Voice messages (the mic-button "press and hold" recording, OGG OPUS).
    // Caption is rare on voice but TG allows it.
    this.bot.on('message:voice', (ctx) => {
      if (ctx.message.from?.is_bot) return
      if (!this.messageHandler) return
      const v = ctx.message.voice
      void this.handleVoiceUpload(ctx, v.file_id, v.mime_type, ctx.message.caption ?? '', v.duration)
    })

    // Audio messages (a music file or the "Audio" attachment button).
    this.bot.on('message:audio', (ctx) => {
      if (ctx.message.from?.is_bot) return
      if (!this.messageHandler) return
      const a = ctx.message.audio
      void this.handleVoiceUpload(ctx, a.file_id, a.mime_type, ctx.message.caption ?? '', a.duration)
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
    this.startMediaCleanup()
    log.info('Telegram adapter started')
  }

  /** Run media cleanup once now (so a long-running im-hub doesn't accumulate
   *  files indefinitely when restarts are infrequent) and then hourly. The
   *  hourly cadence matches the typical 7-day TTL with plenty of slack. */
  private startMediaCleanup(): void {
    if (this.mediaCleanupTimer) clearInterval(this.mediaCleanupTimer)
    void cleanupOldMedia().catch((err) => {
      log.warn({ err: String(err), event: 'telegram.media.cleanup_failed' }, 'startup media cleanup failed')
    })
    this.mediaCleanupTimer = setInterval(() => {
      void cleanupOldMedia().catch((err) => {
        log.warn({ err: String(err), event: 'telegram.media.cleanup_failed' }, 'periodic media cleanup failed')
      })
    }, TelegramAdapter.MEDIA_CLEANUP_INTERVAL_MS)
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
    if (this.mediaCleanupTimer) {
      clearInterval(this.mediaCleanupTimer)
      this.mediaCleanupTimer = undefined
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

  /**
   * Download a TG photo / image-document, save it under MEDIA_ROOT, and surface
   * the result to messageHandler as a Message whose `text` includes the
   * caption (if any) plus a "[图片附件：/path/x.jpg]" marker — claude-code
   * picks that up and uses Read to view it.
   *
   * On download failure we still call messageHandler with a "[图片下载失败]"
   * marker so the user's interaction isn't silently dropped — they can resend
   * or be told what went wrong.
   */
  private async handleMediaUpload(
    ctx: Context,
    fileId: string,
    mime: string | undefined,
    caption: string,
  ): Promise<void> {
    if (!this.bot || !ctx.chat || !ctx.message) return
    const chatId = ctx.chat.id
    const msgId = ctx.message.message_id
    let attachmentLine: string
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('TG returned no file_path')
      const ext = pickExtension(file.file_path, mime)
      const url = `https://api.telegram.org/file/bot${this.config!.botToken}/${file.file_path}`
      const { path } = await downloadToMediaRoot({
        url,
        subdir: `telegram/${chatId}`,
        filename: `${msgId}.${ext}`,
      })
      attachmentLine = `[图片附件：${path}]`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'telegram.media.download_failed', err: msg, chatId, msgId }, 'media download failed')
      attachmentLine = `[图片附件下载失败：${msg}]`
    }

    const text = caption ? `${caption}\n\n${attachmentLine}` : attachmentLine
    const message: Message = {
      id: msgId.toString(),
      threadId: chatId.toString(),
      userId: ctx.message.from?.id?.toString() || 'unknown',
      text,
      timestamp: new Date(ctx.message.date * 1000),
      channelId: this.config?.channelId || 'default',
    }
    const msgCtx: MessageContext = {
      message,
      platform: 'telegram',
      channelId: this.config?.channelId || 'default',
    }
    if (!this.messageHandler) return
    this.messageHandler(msgCtx).catch((err) => {
      log.error({
        err: err instanceof Error ? err.message : String(err),
        threadId: message.threadId,
      }, 'Error in media message handler')
    })
  }

  /**
   * Download a TG voice / audio message, transcribe it via whichever provider
   * is configured (OpenAI Whisper or whisper.cpp), and surface the transcript
   * to messageHandler as Message.text. The downloaded audio file path is
   * also included so the agent can reference it (e.g. send it back, replay).
   *
   * Failures are surfaced as text markers, not silent drops:
   *   - download failure → "[语音附件下载失败：…]"
   *   - no provider configured → "[语音附件未转写：未配置 OPENAI_API_KEY 或 IMHUB_WHISPERCPP_BIN]"
   *   - transcribe error → "[语音转写失败（${provider}）：…]"
   *
   * Since transcription can take 5-30s on a slow CPU + whisper.cpp medium,
   * we fire-and-forget the entire operation so grammy's update queue keeps
   * draining for other chats. Within this chat, ordering is still serialized
   * by grammy.
   */
  private async handleVoiceUpload(
    ctx: Context,
    fileId: string,
    mime: string | undefined,
    caption: string,
    durationSec: number | undefined,
  ): Promise<void> {
    if (!this.bot || !ctx.chat || !ctx.message) return
    const chatId = ctx.chat.id
    const msgId = ctx.message.message_id

    let savedPath: string | null = null
    let downloadErr: string | null = null
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('TG returned no file_path')
      const ext = pickExtension(file.file_path, mime)
      const url = `https://api.telegram.org/file/bot${this.config!.botToken}/${file.file_path}`
      const { path } = await downloadToMediaRoot({
        url,
        subdir: `telegram/${chatId}`,
        filename: `${msgId}.${ext}`,
      })
      savedPath = path
    } catch (err) {
      downloadErr = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'telegram.voice.download_failed', err: downloadErr, chatId, msgId }, 'voice download failed')
    }

    let voiceLine: string
    if (!savedPath) {
      voiceLine = `[语音附件下载失败：${downloadErr}]`
    } else if (detectProvider() === 'none') {
      voiceLine = `[语音附件未转写（未配置 OPENAI_API_KEY 或 IMHUB_WHISPERCPP_BIN）：${savedPath}]`
    } else {
      try {
        const result = await transcribe(savedPath, { language: 'zh' })
        const dur = durationSec != null ? `${durationSec}s, ` : ''
        voiceLine = [
          `[语音转写（${dur}provider=${result.provider}, ${result.elapsedMs}ms）：`,
          result.text || '（空）',
          `源文件：${savedPath}]`,
        ].join('\n')
      } catch (err) {
        const reason = err instanceof TranscribeError
          ? `${err.provider}: ${err.reason}`
          : err instanceof Error ? err.message : String(err)
        voiceLine = `[语音转写失败（${reason}）\n源文件：${savedPath}]`
      }
    }

    const text = caption ? `${caption}\n\n${voiceLine}` : voiceLine
    const message: Message = {
      id: msgId.toString(),
      threadId: chatId.toString(),
      userId: ctx.message.from?.id?.toString() || 'unknown',
      text,
      timestamp: new Date(ctx.message.date * 1000),
      channelId: this.config?.channelId || 'default',
    }
    const msgCtx: MessageContext = {
      message,
      platform: 'telegram',
      channelId: this.config?.channelId || 'default',
    }
    if (!this.messageHandler) return
    this.messageHandler(msgCtx).catch((err) => {
      log.error({
        err: err instanceof Error ? err.message : String(err),
        threadId: message.threadId,
      }, 'Error in voice message handler')
    })
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
