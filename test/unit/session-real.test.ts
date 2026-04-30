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
})
