// Session manager — per-conversation state
//
// On-disk layout (one directory tree per home):
//   ~/.im-hub/sessions/<safe-key>.json   — metadata (no messages)
//   ~/.im-hub/sessions/<safe-key>.log    — append-only JSONL of messages
//
// Splitting the message log out of the JSON metadata avoids rewriting the
// entire history on every chat turn (the old behavior was an O(N) write
// per message). All metadata writes are atomic via writeFile→rename.

import { createHash, randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile, rename, unlink, appendFile } from 'fs/promises'
import type { Session, ChatMessage, SubtaskMeta } from './types.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'session' })

const SESSIONS_DIR = join(homedir(), '.im-hub', 'sessions')

function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
    return createHash('sha256').update(c).digest('hex').slice(0, 8)
  })
}

function sessionFilePath(key: string): string {
  const safe = sanitizeKey(key)
  return join(SESSIONS_DIR, `${safe}.json`)
}

function sessionLogPath(key: string): string {
  const safe = sanitizeKey(key)
  return join(SESSIONS_DIR, `${safe}.log`)
}
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

    log.info({ dir: SESSIONS_DIR }, 'Session manager started')
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
      id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
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
      id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
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
   * Append a message to the session history.
   *
   * Performance: instead of re-serializing the entire session JSON every
   * turn, the message body is appended to a JSONL log file alongside the
   * metadata (which gets a tiny atomic update for `lastActivity`).
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
      // Append-only log avoids rewriting the entire history per turn.
      try {
        await appendFile(sessionLogPath(key), JSON.stringify(message) + '\n')
      } catch {
        // Disk error → fall back to full save which will catch it again
      }
      // Persist metadata only (now small & cheap).
      await this.saveSessionMeta(key, session)
    }
  }

  /**
   * Persist `model` / `variant` / arbitrary patchable fields. Used by
   * `/model`, `/think` etc so the change survives a restart between turns.
   * Mutates the in-memory session in place AND writes metadata atomically.
   */
  async patchSession(
    platform: string, channelId: string, threadId: string,
    patch: Partial<Pick<Session, 'model' | 'variant' | 'agent'>>,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return undefined
    if (patch.model !== undefined) session.model = patch.model || undefined
    if (patch.variant !== undefined) session.variant = patch.variant || undefined
    if (patch.agent !== undefined) session.agent = patch.agent
    session.lastActivity = new Date()
    this.sessions.set(key, session)
    await this.saveSessionMeta(key, session)
    return session
  }

  /**
   * Increment the per-session usage roll-up after a successful agent
   * invocation. Used by router.callAgentWithHistory to power /stats.
   */
  async recordUsage(
    platform: string, channelId: string, threadId: string,
    delta: { costUsd: number; promptChars: number; responseChars: number; durationMs: number },
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return
    if (!session.usage) {
      session.usage = {
        turns: 0,
        costUsd: 0,
        promptChars: 0,
        responseChars: 0,
        durationMsTotal: 0,
        startedAt: new Date().toISOString(),
      }
    }
    session.usage.turns += 1
    session.usage.costUsd += Number.isFinite(delta.costUsd) ? delta.costUsd : 0
    session.usage.promptChars += Number.isFinite(delta.promptChars) ? delta.promptChars : 0
    session.usage.responseChars += Number.isFinite(delta.responseChars) ? delta.responseChars : 0
    session.usage.durationMsTotal += Number.isFinite(delta.durationMs) ? delta.durationMs : 0
    session.lastActivity = new Date()
    this.sessions.set(key, session)
    await this.saveSessionMeta(key, session)
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
      session.id = `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}` // New session ID
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

  /**
   * Create or get a subtask session (independent from parent).
   */
  async getOrCreateSubSession(
    platform: string, channelId: string, threadId: string,
    subtaskId: number, agent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}:sub:${subtaskId}`
    const now = new Date()
    let session = this.sessions.get(key) || await this.loadSession(key)
    if (session) {
      session.lastActivity = now
      return session
    }
    session = {
      id: `sub-${platform}-${channelId}-${threadId}-${subtaskId}`,
      channelId, threadId, platform, agent,
      createdAt: now, lastActivity: now, ttl: DEFAULT_TTL, messages: [],
    }
    this.sessions.set(key, session)
    await this.saveSession(key, session)
    return session
  }

  /**
   * Set active subtask id on parent session — subsequent messages route to the subtask.
   */
  async setActiveSubtask(
    platform: string, channelId: string, threadId: string, taskId: number | null
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return
    session.activeSubtaskId = taskId
    this.sessions.set(key, session)
    await this.saveSession(key, session)
  }

  /**
   * Get subtask metadata list from parent session.
   */
  async getSubtasks(platform: string, channelId: string, threadId: string): Promise<SubtaskMeta[]> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    return session?.subtasks || []
  }

  /**
   * Update subtask metadata in parent session.
   */
  async updateSubtask(
    platform: string, channelId: string, threadId: string,
    taskId: number, patch: Partial<SubtaskMeta>
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return
    if (!session.subtasks) { session.subtasks = [] }
    const idx = session.subtasks.findIndex(s => s.id === taskId)
    if (idx >= 0) {
      session.subtasks[idx] = { ...session.subtasks[idx], ...patch }
    } else {
      session.subtasks.push({ id: taskId, ...patch } as SubtaskMeta)
    }
    this.sessions.set(key, session)
    await this.saveSession(key, session)
  }

  /**
   * Get next subtask id and persist the increment.
   *
   * Previously returned 1 when the parent session didn't exist yet, but
   * never created one — second call returned 1 again, leading to subtask
   * id collisions. Now we lazy-create the parent session so the counter
   * increments durably from the first call.
   */
  async nextSubtaskId(
    platform: string, channelId: string, threadId: string, agent = ''
  ): Promise<number> {
    const key = `${platform}:${channelId}:${threadId}`
    let session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) {
      const now = new Date()
      session = {
        id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
        channelId, threadId, platform, agent,
        createdAt: now, lastActivity: now, ttl: DEFAULT_TTL, messages: [],
        subtaskCounter: 0,
      }
    }
    session.subtaskCounter = (session.subtaskCounter || 0) + 1
    this.sessions.set(key, session)
    await this.saveSession(key, session)
    return session.subtaskCounter
  }

  /**
   * Persist the full session (metadata + messages). Used for the legacy
   * one-file format on resetConversation() and switchAgent() — anywhere
   * the messages array itself was rewritten. Atomic via tmp+rename.
   */
  private async saveSession(key: string, session: Session): Promise<void> {
    await this.saveSessionMeta(key, session)
    // Rewrite the JSONL log to match the in-memory messages array. This is
    // only called from paths that actually mutate `messages` wholesale
    // (resetConversation, switchAgent). addMessage uses appendFile which
    // is far cheaper for the hot path.
    const logPath = sessionLogPath(key)
    try {
      const lines = session.messages.map((m) => JSON.stringify(m)).join('\n')
      await this.atomicWrite(logPath, lines + (lines ? '\n' : ''))
    } catch {
      // disk failure — in-memory state is still authoritative
    }
  }

  /** Persist metadata only (no messages payload), atomically. */
  private async saveSessionMeta(key: string, session: Session): Promise<void> {
    const filePath = sessionFilePath(key)
    try {
      const meta: Omit<Session, 'messages'> & { messageCount: number } = {
        id: session.id,
        channelId: session.channelId,
        threadId: session.threadId,
        platform: session.platform,
        agent: session.agent,
        model: session.model,
        variant: session.variant,
        usage: session.usage,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        ttl: session.ttl,
        activeSubtaskId: session.activeSubtaskId,
        subtasks: session.subtasks,
        subtaskCounter: session.subtaskCounter,
        messageCount: session.messages.length,
      }
      await this.atomicWrite(filePath, JSON.stringify(meta, null, 2))
    } catch {
      // ignore
    }
  }

  /** Crash-safe write: tmp file + atomic rename. */
  private async atomicWrite(filePath: string, contents: string): Promise<void> {
    const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, contents)
    try {
      await rename(tmp, filePath)
    } catch (err) {
      try { await unlink(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  private async loadSession(key: string): Promise<Session | undefined> {
    const filePath = sessionFilePath(key)
    try {
      const data = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(data) as Partial<Session> & { messageCount?: number }
      const session: Session = {
        id: parsed.id!,
        channelId: parsed.channelId!,
        threadId: parsed.threadId!,
        platform: parsed.platform!,
        agent: parsed.agent!,
        model: parsed.model,
        variant: parsed.variant,
        usage: parsed.usage,
        createdAt: new Date(parsed.createdAt!),
        lastActivity: new Date(parsed.lastActivity!),
        ttl: parsed.ttl!,
        messages: parsed.messages || [],  // legacy one-file format
        activeSubtaskId: parsed.activeSubtaskId,
        subtasks: parsed.subtasks,
        subtaskCounter: parsed.subtaskCounter,
      }
      // Convert message timestamps from legacy format if present
      session.messages = session.messages.map((msg) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
      }))
      // Then merge in JSONL log entries (new format).
      try {
        const log = await readFile(sessionLogPath(key), 'utf-8')
        const logged: ChatMessage[] = []
        for (const line of log.split('\n')) {
          if (!line.trim()) continue
          try {
            const m = JSON.parse(line) as ChatMessage
            logged.push({ ...m, timestamp: new Date(m.timestamp) })
          } catch { /* skip corrupt line */ }
        }
        // The log is authoritative for new-format sessions. If both exist
        // (rare, after a save followed by addMessage), the log wins.
        if (logged.length > 0) {
          session.messages = logged
        }
      } catch {
        // No log file — legacy format only
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

        // Delete both metadata and the append-only log
        const filePath = sessionFilePath(key)
        const logPath = sessionLogPath(key)
        try { await unlink(filePath) } catch { /* ignore */ }
        try { await unlink(logPath) } catch { /* ignore */ }
      }
    }
  }
}

export const sessionManager = new SessionManager()
