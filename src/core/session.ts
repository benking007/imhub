// Session manager — per-conversation state

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile, unlink } from 'fs/promises'
import type { Session, ChatMessage } from './types.js'

const SESSIONS_DIR = join(homedir(), '.im-hub', 'sessions')
const DEFAULT_TTL = 30 * 60 * 1000 // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

class SessionManager {
  private sessions = new Map<string, Session>()
  private cleanupTimer?: ReturnType<typeof setInterval>

  async start(): Promise<void> {
    // Ensure sessions directory exists
    await mkdir(SESSIONS_DIR, { recursive: true })

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL)

    console.log(`Session manager started (sessions: ${SESSIONS_DIR})`)
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
  }

  /**
   * Get or create a session for a conversation
   * Session key: `${platform}:${channelId}:${threadId}`
   */
  async getOrCreateSession(
    platform: string,
    channelId: string,
    threadId: string,
    agent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}`
    const now = new Date()

    // Check memory cache
    let session = this.sessions.get(key)

    if (session) {
      // Check if expired
      if (now.getTime() - session.lastActivity.getTime() > session.ttl) {
        // Expired — create new
        session = undefined
      } else {
        // Update activity
        session.lastActivity = now
        await this.saveSession(key, session)
        return session
      }
    }

    // Try loading from disk
    session = await this.loadSession(key)

    if (session && now.getTime() - session.lastActivity.getTime() <= session.ttl) {
      // Found and valid
      session.lastActivity = now
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return session
    }

    // Create new session
    session = {
      id: `${platform}-${channelId}-${threadId}-${Date.now()}`,
      channelId,
      threadId,
      platform,
      agent,
      createdAt: now,
      lastActivity: now,
      ttl: DEFAULT_TTL,
      messages: [],
    }

    this.sessions.set(key, session)
    await this.saveSession(key, session)

    return session
  }

  /**
   * Get existing session without creating a new one
   * Returns undefined if no session exists or it's expired
   */
  async getExistingSession(platform: string, channelId: string, threadId: string): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const now = new Date()

    // Check memory cache
    let session = this.sessions.get(key)

    if (session) {
      // Check if expired
      if (now.getTime() - session.lastActivity.getTime() > session.ttl) {
        return undefined
      }
      return session
    }

    // Try loading from disk
    session = await this.loadSession(key)

    if (session && now.getTime() - session.lastActivity.getTime() <= session.ttl) {
      // Found and valid — cache it
      this.sessions.set(key, session)
      return session
    }

    return undefined
  }

  /**
   * Switch the agent for a session
   * Generates a new session ID but preserves thread identity
   */
  async switchAgent(
    platform: string,
    channelId: string,
    threadId: string,
    newAgent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}`

    // Get existing session or create new
    const existing = this.sessions.get(key) || await this.loadSession(key)

    const now = new Date()
    const session: Session = {
      id: `${platform}-${channelId}-${threadId}-${Date.now()}`,
      channelId,
      threadId,
      platform,
      agent: newAgent,
      createdAt: existing?.createdAt || now,
      lastActivity: now,
      ttl: DEFAULT_TTL,
      messages: existing?.messages || [],
    }

    this.sessions.set(key, session)
    await this.saveSession(key, session)

    return session
  }

  /**
   * Add a message to the session history
   */
  async addMessage(
    platform: string,
    channelId: string,
    threadId: string,
    message: ChatMessage
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)

    if (session) {
      session.messages.push(message)
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSession(key, session)
    }
  }

  /**
   * Reset conversation history (keep session but clear messages)
   */
  async resetConversation(
    platform: string,
    channelId: string,
    threadId: string
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)

    if (session) {
      session.messages = []
      session.lastActivity = new Date()
      session.id = `${platform}-${channelId}-${threadId}-${Date.now()}` // New session ID
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return session
    }

    return undefined
  }

  /**
   * Get session with messages (convenience method)
   */
  async getSessionWithHistory(
    platform: string,
    channelId: string,
    threadId: string
  ): Promise<{ session: Session; messages: ChatMessage[] } | undefined> {
    const session = await this.getExistingSession(platform, channelId, threadId)
    if (session) {
      return { session, messages: session.messages }
    }
    return undefined
  }

  private async saveSession(key: string, session: Session): Promise<void> {
    const filePath = join(SESSIONS_DIR, `${key.replace(/:/g, '-')}.json`)
    try {
      await writeFile(filePath, JSON.stringify(session, null, 2))
    } catch {
      // Ignore save errors — in-memory still works
    }
  }

  private async loadSession(key: string): Promise<Session | undefined> {
    const filePath = join(SESSIONS_DIR, `${key.replace(/:/g, '-')}.json`)
    try {
      const data = await readFile(filePath, 'utf-8')
      const session = JSON.parse(data) as Session
      // Convert date strings back to Date objects
      session.createdAt = new Date(session.createdAt)
      session.lastActivity = new Date(session.lastActivity)
      // Convert message timestamps
      if (session.messages) {
        session.messages = session.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }))
      } else {
        session.messages = []
      }
      return session
    } catch {
      return undefined
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now()

    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > session.ttl) {
        this.sessions.delete(key)

        // Delete from disk
        const filePath = join(SESSIONS_DIR, `${key.replace(/:/g, '-')}.json`)
        try {
          await unlink(filePath)
        } catch {
          // Ignore delete errors
        }
      }
    }
  }
}

export const sessionManager = new SessionManager()
