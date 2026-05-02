// Integration tests for the real SessionManager (singleton from session.ts).
//
// Verifies:
//   - addMessage appends to the JSONL log (no full rewrite per turn)
//   - metadata file is atomic (no .tmp leftover after a write)
//   - nextSubtaskId increments durably across calls (P1-C fix)
//   - resetConversation truncates messages but preserves session id
//   - legacy single-file format still loads (back-compat)

import { describe, it, expect, beforeEach } from 'bun:test'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { sessionManager } from '../../src/core/session'

const SESSIONS_DIR = join(homedir(), '.im-hub', 'sessions')

function uniqueKey(prefix: string): { platform: string; channelId: string; threadId: string } {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { platform: 'test', channelId: 'ch-' + id, threadId: 't-' + id }
}

/** Mirror sanitizeKey() from session.ts so tests can find the on-disk file. */
function sanitize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) =>
    createHash('sha256').update(c).digest('hex').slice(0, 8))
}

function fileStem(k: { platform: string; channelId: string; threadId: string }): string {
  return sanitize(`${k.platform}:${k.channelId}:${k.threadId}`)
}

async function cleanupKey(k: { platform: string; channelId: string; threadId: string }): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) return
  const stem = fileStem(k)
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (name.startsWith(stem)) {
      try { await unlink(join(SESSIONS_DIR, name)) } catch { /* ignore */ }
    }
  }
}

describe('SessionManager (real, on-disk)', () => {
  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
  })

  it('addMessage appends to JSONL log', async () => {
    const k = uniqueKey('append')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'hi', timestamp: new Date() })
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'assistant', content: 'hello', timestamp: new Date() })

      const logFile = join(SESSIONS_DIR, `${fileStem(k)}.log`)
      const log = await readFile(logFile, 'utf-8')
      const lines = log.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
      expect(JSON.parse(lines[0]).role).toBe('user')
      expect(JSON.parse(lines[1]).role).toBe('assistant')
    } finally {
      await cleanupKey(k)
    }
  })

  it('does not leave .tmp files after atomic write', async () => {
    const k = uniqueKey('atomic')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'a', timestamp: new Date() })
      const leftover = readdirSync(SESSIONS_DIR).filter((n) =>
        n.startsWith(fileStem(k)) && n.endsWith('.tmp'))
      expect(leftover).toEqual([])
    } finally {
      await cleanupKey(k)
    }
  })

  it('nextSubtaskId increments durably (P1-C)', async () => {
    const k = uniqueKey('subtask')
    try {
      const a = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      const b = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      const c = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      expect(a).toBe(1)
      expect(b).toBe(2)
      expect(c).toBe(3)
    } finally {
      await cleanupKey(k)
    }
  })

  it('reads legacy one-file format that contains messages inline', async () => {
    // Manually write a legacy-shaped session file (no .log companion).
    const k = uniqueKey('legacy')
    try {
      const legacy = {
        id: 'legacy-1',
        channelId: k.channelId,
        threadId: k.threadId,
        platform: k.platform,
        agent: 'opencode',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        ttl: 60_000,
        messages: [
          { role: 'user', content: 'legacy-hi', timestamp: new Date().toISOString() },
        ],
      }
      await writeFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), JSON.stringify(legacy))

      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.messages.length).toBe(1)
      expect(reloaded?.messages[0].content).toBe('legacy-hi')
    } finally {
      await cleanupKey(k)
    }
  })

  it('resetConversation clears messages and assigns new id', async () => {
    const k = uniqueKey('reset')
    try {
      const s1 = await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      const oldId = s1.id  // capture before reset mutates the shared ref
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'hi', timestamp: new Date() })
      const s2 = await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      expect(s2).toBeDefined()
      expect(s2!.id).not.toBe(oldId)
      expect(s2!.messages.length).toBe(0)
    } finally {
      await cleanupKey(k)
    }
  })

  // Regression for the v2 Phase D promise: claudeSessionId / claudeSessionPrimed
  // must round-trip through saveSessionMeta → loadSession so that "META TTL 7d"
  // actually preserves Claude's resumable session across restarts.
  it('claudeSessionId persists to disk and reloads', async () => {
    const k = uniqueKey('claude-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setClaudeSessionId(k.platform, k.channelId, k.threadId, 'uuid-abc-123')
      await sessionManager.markClaudeSessionPrimed(k.platform, k.channelId, k.threadId)

      const metaPath = join(SESSIONS_DIR, `${fileStem(k)}.json`)
      const onDisk = JSON.parse(await readFile(metaPath, 'utf-8'))
      expect(onDisk.claudeSessionId).toBe('uuid-abc-123')
      expect(onDisk.claudeSessionPrimed).toBe(true)

      // Force a fresh load by evicting from in-memory cache.
      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)

      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.claudeSessionId).toBe('uuid-abc-123')
      expect(reloaded?.claudeSessionPrimed).toBe(true)
    } finally {
      await cleanupKey(k)
    }
  })

  // Regression for the bug where switchAgent rebuilt the Session object
  // explicitly and dropped every field that wasn't in its hand-written list —
  // including claudeSessionId, usage, and any active subtask. The whole point
  // of "sticky agent + claudeSessionId survives 7d" was undercut by /cc /oc
  // round-trips silently nulling those fields.
  it('switchAgent preserves thread-level fields across an agent change', async () => {
    const k = uniqueKey('switch-carry')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setClaudeSessionId(k.platform, k.channelId, k.threadId, 'uuid-keepme')
      await sessionManager.markClaudeSessionPrimed(k.platform, k.channelId, k.threadId)
      await sessionManager.recordUsage(k.platform, k.channelId, k.threadId, {
        costUsd: 0.5, promptChars: 100, responseChars: 200, durationMs: 1000,
      })
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'pre-switch', timestamp: new Date() })

      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'opencode')
      expect(switched.agent).toBe('opencode')
      // Preserved across agent switch:
      expect(switched.claudeSessionId).toBe('uuid-keepme')
      expect(switched.claudeSessionPrimed).toBe(true)
      expect(switched.usage?.costUsd).toBe(0.5)
      expect(switched.usage?.turns).toBe(1)
      expect(switched.messages.length).toBe(1)
      expect(switched.messages[0].content).toBe('pre-switch')

      // And persisted to disk, not just held in memory:
      const onDisk = JSON.parse(await readFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), 'utf-8'))
      expect(onDisk.claudeSessionId).toBe('uuid-keepme')
      expect(onDisk.claudeSessionPrimed).toBe(true)
      expect(onDisk.usage?.costUsd).toBe(0.5)
    } finally {
      await cleanupKey(k)
    }
  })

  // opencode session id round-trip — same shape as claudeSessionId test but
  // covers the second per-agent CLI session field. Regression for the
  // 2026-05-02 fix where opencode adapter learned to call
  // setOpencodeSessionId via the inspectEvent / opts.onAgentSessionId
  // pipeline.
  it('opencodeSessionId persists to disk and survives switchAgent', async () => {
    const k = uniqueKey('opencode-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      await sessionManager.setOpencodeSessionId(k.platform, k.channelId, k.threadId, 'ses_test123')

      // Round-trip through disk:
      const meta = JSON.parse(await readFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), 'utf-8'))
      expect(meta.opencodeSessionId).toBe('ses_test123')

      // Force fresh load to confirm loadSession reads the field:
      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)
      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.opencodeSessionId).toBe('ses_test123')

      // And survives the /cc → /oc round-trip:
      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'claude-code')
      expect(switched.opencodeSessionId).toBe('ses_test123')

      // /new must clear it (clean slate for both per-agent CLI sessions):
      const reset = await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      expect(reset?.opencodeSessionId).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })

  // setOpencodeSessionId is idempotent — opencode emits the same sessionID
  // on every event in a run; the adapter forwards each one and we need to
  // tolerate that without re-writing meta or bumping lastActivity.
  it('setOpencodeSessionId is idempotent for the same id', async () => {
    const k = uniqueKey('opencode-idempotent')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      const a = await sessionManager.setOpencodeSessionId(k.platform, k.channelId, k.threadId, 'ses_x')
      const b = await sessionManager.setOpencodeSessionId(k.platform, k.channelId, k.threadId, 'ses_x')
      expect(a?.opencodeSessionId).toBe('ses_x')
      expect(b?.opencodeSessionId).toBe('ses_x')

      // A different id replaces it (in case opencode generates a new one
      // because we forked / lost the old one).
      const c = await sessionManager.setOpencodeSessionId(k.platform, k.channelId, k.threadId, 'ses_y')
      expect(c?.opencodeSessionId).toBe('ses_y')
    } finally {
      await cleanupKey(k)
    }
  })
})
