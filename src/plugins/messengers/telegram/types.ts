// Telegram adapter types

export interface TelegramConfig {
  botToken: string
  channelId?: string  // Optional channel ID for multi-channel support
  /** HTTP proxy URL (e.g., http://127.0.0.1:7890) for regions where Telegram is blocked */
  proxy?: string
  /** When set + non-empty, only Telegram user IDs in this list may resolve
   *  approvals via inline-button callbacks. Stringified user_id (TG numeric).
   *  If absent or empty, button taps from anyone in the chat are accepted —
   *  matches the existing text-reply path's permissiveness, fine for 1:1
   *  bots but a real risk in shared groups.
   *
   *  Note: this gates BUTTONS only. y/n text replies remain unrestricted to
   *  preserve existing behavior; tighten there separately if needed. */
  approvalAllowlist?: string[]
}

export interface SendMessageResult {
  message_id: number
  chat: {
    id: number
  }
}

export interface TelegramMessageUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: {
      id: number
      is_bot: boolean
      first_name: string
      username?: string
    }
    chat: {
      id: number
      type: 'private' | 'group' | 'supergroup' | 'channel'
      title?: string
      username?: string
    }
    date: number
    text?: string
    entities?: Array<{
      type: string
      offset: number
      length: number
    }>
  }
}
