// Discord adapter types

export interface DiscordConfig {
  botToken: string
  channelId?: string  // Optional channel ID for multi-channel support
  /** Only respond in these guilds (server IDs). Empty = all guilds. */
  allowedGuilds?: string[]
  /** Only respond in these channels. Empty = all channels. */
  allowedChannels?: string[]
}
