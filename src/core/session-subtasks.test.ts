// listAllSubtasks — covers the dashboard's flattened-subtask view. We can't
// monkey-patch SESSIONS_DIR (it's a const), so this test goes via the real
// public API: nextSubtaskId + updateSubtask write to ~/.im-hub/sessions, and
// we then read them back and clean up.
//
// We use a unique platform/channelId/threadId triple so we don't collide with
// any real sessions and we delete them afterwards.

import { describe, it, expect, afterEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { unlink, readdir } from 'fs/promises'
import { sessionManager } from './session.js'

const PLATFORM = 'subtest'
const CHANNEL = 'c-' + Math.random().toString(36).slice(2, 8)
const THREAD = 't-' + Math.random().toString(36).slice(2, 8)

const SESSIONS_DIR = join(homedir(), '.im-hub', 'sessions')

async function cleanupTestSessions(): Promise<void> {
  // The session manager sanitizes the key, so we can't compute the filename.
  // Instead, scan and delete any file whose JSON has our test platform.
  let names: string[]
  try { names = await readdir(SESSIONS_DIR) } catch { return }
  const { readFile } = await import('fs/promises')
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(SESSIONS_DIR, name), 'utf-8')
      const parsed = JSON.parse(raw) as { platform?: string }
      if (parsed.platform === PLATFORM) {
        await unlink(join(SESSIONS_DIR, name)).catch(() => {})
        await unlink(join(SESSIONS_DIR, name.replace(/\.json$/, '.log'))).catch(() => {})
      }
    } catch { /* ignore */ }
  }
}

afterEach(async () => {
  await cleanupTestSessions()
})

describe('sessionManager.listAllSubtasks', () => {
  it('returns subtasks across all sessions, flattened with parent context', async () => {
    // Spawn two subtasks in our test session.
    const id1 = await sessionManager.nextSubtaskId(PLATFORM, CHANNEL, THREAD, 'claude-code')
    await sessionManager.updateSubtask(PLATFORM, CHANNEL, THREAD, id1, {
      id: id1, agent: 'claude-code', prompt: 'hello',
      status: 'running', createdAt: new Date('2026-05-01T09:00:00Z'),
    })
    const id2 = await sessionManager.nextSubtaskId(PLATFORM, CHANNEL, THREAD, 'claude-code')
    await sessionManager.updateSubtask(PLATFORM, CHANNEL, THREAD, id2, {
      id: id2, agent: 'opencode', prompt: 'world',
      status: 'completed', createdAt: new Date('2026-05-01T10:00:00Z'),
    })

    const all = await sessionManager.listAllSubtasks()
    const ours = all.filter((s) => s.platform === PLATFORM)
    expect(ours.length).toBe(2)

    // newest first
    expect(ours[0].createdAt.getTime()).toBeGreaterThan(ours[1].createdAt.getTime())

    // parent context attached
    for (const s of ours) {
      expect(s.platform).toBe(PLATFORM)
      expect(s.channelId).toBe(CHANNEL)
      expect(s.threadId).toBe(THREAD)
      expect(s.parentSessionId).toContain(PLATFORM)
    }
    expect(ours.find((s) => s.agent === 'opencode')?.status).toBe('completed')
  })

  it('returns empty array when no sessions on disk match', async () => {
    // No subtasks written for our (unique) platform. Other real sessions
    // may exist; our filter shows ours is zero.
    const all = await sessionManager.listAllSubtasks()
    expect(all.filter((s) => s.platform === PLATFORM).length).toBe(0)
  })
})
