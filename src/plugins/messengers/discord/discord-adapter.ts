// Discord Bot API Adapter using discord.js
// Implements MessengerAdapter interface with typing indicator support

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
} from 'discord.js'
import type { MessengerAdapter, MessageContext, Message } from '../../../core/types.js'
import type { DiscordConfig } from './types.js'
import { markdownToDiscord } from './markdown-to-discord.js'
import { splitMessage } from '../../../utils/message-split.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'discord' })

// Discord message limit is 2000 characters
const DISCORD_MAX_LENGTH = 2000

export class DiscordAdapter implements MessengerAdapter {
  readonly name = 'discord'
  private client: Client | null = null
  private config: DiscordConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private isRunning = false
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()

  async start(): Promise<void> {
    // Load config
    const { readFile } = await import('fs/promises')
    const { homedir } = await import('os')
    const { join } = await import('path')

    const configPath = join(homedir(), '.im-hub', 'config.json')
    try {
      const data = await readFile(configPath, 'utf-8')
      const config = JSON.parse(data)
      this.config = config.discord as DiscordConfig
    } catch {
      throw new Error('Discord config not found. Run "im-hub config discord" first.')
    }

    if (!this.config?.botToken) {
      throw new Error('Discord bot token not configured. Run "im-hub config discord" first.')
    }

    // Initialize Discord client with required intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,      // Privileged intent - must enable in Developer Portal
        GatewayIntentBits.DirectMessages,       // For DM support
      ],
      partials: [
        Partials.Channel,   // Required for DM support
        Partials.Message,
      ],
    })

    // Ready event
    this.client.on('ready', (client) => {
      log.info({ user: client.user.tag, guilds: client.guilds.cache.size },
        `Discord bot logged in as ${client.user.tag}`)
    })

    // Set up message handler
    this.client.on('messageCreate', async (message: DiscordMessage) => {
      await this.handleDiscordMessage(message)
    })

    // Error handling
    this.client.on('error', (error) => {
      log.error({ err: error.message }, 'Discord client error')
    })

    this.client.on('warn', (warning) => {
      log.warn({ warning }, 'Discord client warning')
    })

    // Login to Discord
    await this.client.login(this.config.botToken)
    this.isRunning = true
    log.info('Discord adapter started')
  }

  async stop(): Promise<void> {
    this.isRunning = false

    // Clean up all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()

    if (this.client) {
      this.client.destroy()
      this.client = null
    }

    log.info('Discord adapter stopped')
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Discord adapter not started')
    }

    const channel = await this.fetchSendableChannel(threadId)
    if (!channel) {
      throw new Error(`Channel ${threadId} not found or not text-based`)
    }

    // Convert markdown and split into chunks
    const discordText = markdownToDiscord(text)
    const chunks = splitMessage(discordText, {
      maxLength: DISCORD_MAX_LENGTH,
      addContinuationMarker: false,
    })

    for (const chunk of chunks) {
      await channel.send(chunk)
    }
  }

  async sendTyping(threadId: string, isTyping: boolean): Promise<void> {
    if (!this.client) {
      return
    }

    if (isTyping) {
      const channel = await this.fetchSendableChannel(threadId)
      if (!channel) {
        return
      }

      // Send initial typing indicator
      try {
        await channel.sendTyping()
      } catch {
        // Ignore errors during typing
      }

      // Clear any existing interval
      const existing = this.typingIntervals.get(threadId)
      if (existing) {
        clearInterval(existing)
      }

      // Discord typing indicator lasts ~10 seconds, refresh every 8 seconds
      const interval = setInterval(async () => {
        try {
          await channel.sendTyping()
        } catch {
          // Ignore errors during typing refresh
        }
      }, 8000)

      this.typingIntervals.set(threadId, interval)
    } else {
      // Clear the refresh interval
      const interval = this.typingIntervals.get(threadId)
      if (interval) {
        clearInterval(interval)
        this.typingIntervals.delete(threadId)
      }
      // Note: Discord has no "cancel typing" API - it just expires naturally
    }
  }

  // ============================================
  // Internal methods
  // ============================================

  private async fetchSendableChannel(threadId: string): Promise<TextChannel | DMChannel | null> {
    if (!this.client) return null
    const channel = await this.client.channels.fetch(threadId).catch(() => null)
    if (!channel) return null
    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.DM) {
      return channel as TextChannel | DMChannel
    }
    // Also support announcement/thread channels
    if (channel.isTextBased() && 'send' in channel) {
      return channel as unknown as TextChannel
    }
    return null
  }

  private async handleDiscordMessage(message: DiscordMessage): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.author.bot) {
      return
    }

    // Guild whitelist filter
    if (this.config?.allowedGuilds?.length && message.guildId) {
      if (!this.config.allowedGuilds.includes(message.guildId)) {
        log.debug({ guildId: message.guildId }, 'Message from non-whitelisted guild, ignoring')
        return
      }
    }

    // Channel whitelist filter
    if (this.config?.allowedChannels?.length) {
      if (!this.config.allowedChannels.includes(message.channelId)) {
        log.debug({ channelId: message.channelId }, 'Message from non-whitelisted channel, ignoring')
        return
      }
    }

    // Skip empty messages (e.g. image-only, embed-only)
    if (!message.content && !message.attachments.size) {
      return
    }

    if (!this.messageHandler) {
      log.debug('No message handler registered')
      return
    }

    try {
      const msg: Message = {
        id: message.id,
        threadId: message.channelId,
        userId: message.author.id,
        text: message.content || '',
        timestamp: message.createdAt,
        channelId: this.config?.channelId || 'default',
      }

      const msgCtx: MessageContext = {
        message: msg,
        platform: 'discord',
        channelId: this.config?.channelId || 'default',
      }

      log.debug({ threadId: msg.threadId, userId: msg.userId }, 'Calling message handler')
      await this.messageHandler(msgCtx)
      log.debug({ threadId: msg.threadId }, 'Message handler completed')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      log.error({ err: errMsg, stack }, 'Error in message handler')
    }
  }
}

// Singleton instance
export const discordAdapter = new DiscordAdapter()
