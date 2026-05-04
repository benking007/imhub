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
import { mkdir, readFile, writeFile, rename, unlink, appendFile, readdir } from 'fs/promises'
import type { Session, ChatMessage, SubtaskMeta } from './types.js'
import { approvalBus } from './approval-bus.js'
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
// Two-tier TTL (split out to fix the "agent drift after long pause" issue):
//
//   MESSAGES_TTL  — how long the in-memory chat history sticks around before
//                   we drop it from RAM and delete the .log file. Short by
//                   default (30 min) because a long pause usually means the
//                   user has switched topics; replaying stale messages back to
//                   the agent just bloats the prompt.
//
//   META_TTL      — how long the *session metadata* (agent, model, variant,
//                   claudeSessionId, claudeSessionPrimed, usage stats) lives
//                   on disk. Long by default (7 days) so the thread's "sticky
//                   agent" and resumable claude-code session id survive
//                   overnight / weekend gaps. Without this, a 30-minute
//                   silence followed by a coding-keyword message would
//                   re-classify and switch agents (e.g. claude-code → opencode).
//
// Both are env-overridable for ops tuning.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const MESSAGES_TTL = envInt('IMHUB_SESSION_MESSAGES_TTL_MS', 30 * 60 * 1000)
const META_TTL = envInt('IMHUB_SESSION_META_TTL_MS', 7 * 24 * 60 * 60 * 1000)
// Back-compat: external callers (tests, schedule.ts) used to import DEFAULT_TTL
// to mean "the one ttl". Keep the symbol pointing at META_TTL so anywhere it
// still appears in logs/metrics gets the long-lived value.
const DEFAULT_TTL = META_TTL
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

function metaStale(s: { lastActivity: Date }, now: number = Date.now()): boolean {
  return now - s.lastActivity.getTime() > META_TTL
}
function messagesStale(s: { lastActivity: Date }, now: number = Date.now()): boolean {
  return now - s.lastActivity.getTime() > MESSAGES_TTL
}

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
      if (metaStale(session, now.getTime())) {
        session = undefined  // fully expired → create new below
      } else {
        if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
          session.messages = []
          try { await unlink(sessionLogPath(key)) } catch { /* no log to drop */ }
        }
        session.lastActivity = now
        await this.saveSessionMeta(key, session)
        return session
      }
    }

    // Try loading from disk
    session = await this.loadSession(key)

    if (session && !metaStale(session, now.getTime())) {
      if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
        session.messages = []
        try { await unlink(sessionLogPath(key)) } catch { /* no log to drop */ }
      }
      session.lastActivity = now
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
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
      if (metaStale(session, now.getTime())) {
        return undefined
      }
      if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
        // Drop stale chat history but preserve metadata (sticky agent,
        // claudeSessionId etc.) — that's the whole point of META_TTL.
        session.messages = []
        try { await unlink(sessionLogPath(key)) } catch { /* ignore */ }
      }
      return session
    }

    // Try loading from disk
    session = await this.loadSession(key)

    if (session && !metaStale(session, now.getTime())) {
      if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
        session.messages = []
        try { await unlink(sessionLogPath(key)) } catch { /* ignore */ }
      }
      this.sessions.set(key, session)
      return session
    }

    return undefined
  }

  /**
   * Switch the agent for a session.
   *
   * Generates a new session id but preserves thread identity AND every
   * thread-level field that isn't agent-specific:
   *   - usage             (per-thread /stats roll-up)
   *   - subtasks/active   (subtask state lives at thread level)
   *   - claudeSessionId   (Claude UUID survives /oc → /cc round-trips so the
   *                        underlying ~/.claude/projects jsonl keeps continuing
   *                        when the user comes back to claude)
   *
   * `model` and `variant` are reset because they live in different namespaces
   * across CLIs (`opencode` model ≠ `claude` model); carrying them across
   * would just feed the new agent an unrecognized argument.
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
      usage: existing?.usage,
      activeSubtaskId: existing?.activeSubtaskId,
      subtasks: existing?.subtasks,
      subtaskCounter: existing?.subtaskCounter,
      claudeSessionId: existing?.claudeSessionId,
      claudeSessionPrimed: existing?.claudeSessionPrimed,
      opencodeSessionId: existing?.opencodeSessionId,
      planMode: existing?.planMode,
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
    patch: Partial<Pick<Session, 'model' | 'variant' | 'agent' | 'planMode'>>,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return undefined
    if (patch.model !== undefined) session.model = patch.model || undefined
    if (patch.variant !== undefined) session.variant = patch.variant || undefined
    if (patch.agent !== undefined) session.agent = patch.agent
    if (patch.planMode !== undefined) {
      // Normalize to canonical shape: true keeps the flag, false drops it.
      // Storing only the truthy state keeps the on-disk JSON small and lets
      // a missing field unambiguously mean "off".
      if (patch.planMode) session.planMode = true
      else delete session.planMode
    }
    session.lastActivity = new Date()
    this.sessions.set(key, session)
    await this.saveSessionMeta(key, session)
    return session
  }

  /**
   * Persist claude-code resumable session bookkeeping (UUID + primed flag).
   * Returns the updated session, or undefined if no session exists yet for
   * this thread. Caller is expected to ensure the session exists first.
   */
  async setClaudeSessionId(
    platform: string, channelId: string, threadId: string,
    claudeSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return undefined
    session.claudeSessionId = claudeSessionId
    session.lastActivity = new Date()
    this.sessions.set(key, session)
    await this.saveSessionMeta(key, session)
    return session
  }

  async markClaudeSessionPrimed(
    platform: string, channelId: string, threadId: string,
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session || session.claudeSessionPrimed) return
    session.claudeSessionPrimed = true
    session.lastActivity = new Date()
    this.sessions.set(key, session)
    await this.saveSessionMeta(key, session)
  }

  /**
   * Persist opencode's native session id (`ses_…`) once we've seen it in the
   * adapter's stream. Idempotent — calling with the same id is a no-op so
   * the per-event callback can fire as many times as opencode sends events.
   */
  async setOpencodeSessionId(
    platform: string, channelId: string, threadId: string,
    opencodeSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    if (!session) return undefined
    if (session.opencodeSessionId === opencodeSessionId) return session
    session.opencodeSessionId = opencodeSessionId
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
      // Forget the old per-agent CLI sessions — /new should give a clean slate
      // for both Claude (`--resume`) and opencode (`--session`).
      delete session.claudeSessionId
      delete session.claudeSessionPrimed
      delete session.opencodeSessionId
      // Plan mode is per-conversation intent ("先规划再动手") — a fresh
      // conversation always starts at "off" so users don't get a surprising
      // read-only run after /new.
      delete session.planMode
      // Drop any per-thread auto-allow approval rules so the new conversation
      // starts back at "ask every time".
      try { approvalBus.clearAutoAllowForThread(threadId) } catch { /* ignore */ }
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
   * Scan all session files on disk and return every subtask, flattened, with
   * its parent platform/channelId/threadId/agent attached so the dashboard
   * can render subtasks across all conversations.
   *
   * Session files live as `<sanitized-key>.json` under SESSIONS_DIR. The
   * sanitized key is one-way (sha256-prefix per non-alnum char), so we
   * cannot reverse it — but each session file preserves the original
   * platform/channelId/threadId fields, which is what we need.
   */
  async listAllSubtasks(): Promise<Array<SubtaskMeta & {
    platform: string
    channelId: string
    threadId: string
    parentAgent: string
    parentSessionId: string
  }>> {
    let names: string[]
    try {
      names = await readdir(SESSIONS_DIR)
    } catch {
      return []
    }
    const out: Array<SubtaskMeta & {
      platform: string
      channelId: string
      threadId: string
      parentAgent: string
      parentSessionId: string
    }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await readFile(join(SESSIONS_DIR, name), 'utf-8')
        const parsed = JSON.parse(raw) as Partial<Session>
        if (!parsed.subtasks?.length) continue
        for (const st of parsed.subtasks) {
          out.push({
            ...st,
            createdAt: st.createdAt ? new Date(st.createdAt) : new Date(0),
            completedAt: st.completedAt ? new Date(st.completedAt) : undefined,
            platform: parsed.platform || '',
            channelId: parsed.channelId || '',
            threadId: parsed.threadId || '',
            parentAgent: parsed.agent || '',
            parentSessionId: parsed.id || '',
          })
        }
      } catch {
        // skip corrupt session file
      }
    }
    // newest first
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return out
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
        claudeSessionId: session.claudeSessionId,
        claudeSessionPrimed: session.claudeSessionPrimed,
        opencodeSessionId: session.opencodeSessionId,
        planMode: session.planMode,
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
        claudeSessionId: parsed.claudeSessionId,
        claudeSessionPrimed: parsed.claudeSessionPrimed,
        opencodeSessionId: parsed.opencodeSessionId,
        planMode: parsed.planMode,
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
      const idle = now - session.lastActivity.getTime()
      if (idle > META_TTL) {
        // Full eviction: thread truly cold. Drop both files + cache entry.
        this.sessions.delete(key)
        const filePath = sessionFilePath(key)
        const logPath = sessionLogPath(key)
        try { await unlink(filePath) } catch { /* ignore */ }
        try { await unlink(logPath) } catch { /* ignore */ }
      } else if (idle > MESSAGES_TTL && session.messages.length > 0) {
        // Messages-only eviction: keep sticky agent / claudeSessionId on disk
        // (meta file untouched), drop chat log + in-memory messages so the
        // next turn starts with a fresh history but the same routing.
        session.messages = []
        const logPath = sessionLogPath(key)
        try { await unlink(logPath) } catch { /* ignore */ }
      }
    }
  }
}

export const sessionManager = new SessionManager()
