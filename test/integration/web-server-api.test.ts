// Integration tests for the new Web REST endpoints (P2-A/D/G + health).
//
// Boots the real Web server on an ephemeral port and exercises:
//   GET  /api/metrics           Prometheus + JSON
//   GET  /api/health            health roll-up
//   GET  /api/workspaces        workspace registry list
//   POST /api/notify            outgoing webhook → IM messenger
//   POST /api/invoke            third-party agent invocation

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { startWebServer } from '../../src/web/server'
import { registry } from '../../src/core/registry'
import { recordInvocation, reset as resetMetrics } from '../../src/core/metrics'
import type { AgentAdapter, MessengerAdapter } from '../../src/core/types'

const captured: Array<{ threadId: string; text: string }> = []

const stubAgent: AgentAdapter = {
  name: 'rest-stub',
  aliases: ['rs'],
  isAvailable: async () => true,
  sendPrompt: async function* () { yield 'rest-stub-reply' },
}

const stubMessenger: MessengerAdapter = {
  name: 'rest-msg',
  start: async () => {},
  stop: async () => {},
  onMessage: () => {},
  sendMessage: async (threadId, text) => { captured.push({ threadId, text }) },
}

const TOKEN_DIR = join(homedir(), '.im-hub')
const TOKEN_FILE = join(TOKEN_DIR, 'web-token')
const TEST_TOKEN = 'web-test-token-1234567890abc'

let port = 0
let close: () => void

beforeAll(async () => {
  registry.registerAgent(stubAgent)
  registry.registerMessenger(stubMessenger)
  mkdirSync(TOKEN_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, TEST_TOKEN, { mode: 0o600 })
  port = 8000 + Math.floor(Math.random() * 1000)
  const server = await startWebServer({ port, defaultAgent: 'rest-stub' })
  close = server.close
})

afterAll(() => {
  close?.()
})

const url = (path: string): string => `http://127.0.0.1:${port}${path}`
const auth = { 'x-im-hub-token': TEST_TOKEN }

describe('Web REST API', () => {
  describe('/api/metrics', () => {
    it('returns Prometheus format by default', async () => {
      resetMetrics()
      recordInvocation({ agent: 'rest-stub', intent: 'topic', platform: 'wechat', durationMs: 50, cost: 0.001, success: true })
      const res = await fetch(url('/api/metrics'), { headers: auth })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('im_hub_uptime_seconds')
      expect(text).toContain('im_hub_agent_invocations_total')
    })

    it('returns JSON when ?format=json', async () => {
      const res = await fetch(url('/api/metrics?format=json'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { agents: unknown[]; uptimeSec: number }
      expect(Array.isArray(body.agents)).toBe(true)
      expect(typeof body.uptimeSec).toBe('number')
    })

    it('rejects without auth', async () => {
      const res = await fetch(url('/api/metrics'))
      expect(res.status).toBe(401)
    })
  })

  describe('/api/health', () => {
    it('reports agent statuses', async () => {
      const res = await fetch(url('/api/health'), { headers: auth })
      // Either 200 (some healthy) or 503 (none) — both are valid; just
      // assert shape.
      expect([200, 503]).toContain(res.status)
      const body = await res.json() as { agents: Record<string, boolean>; uptimeSec: number }
      expect(typeof body.uptimeSec).toBe('number')
      expect(typeof body.agents).toBe('object')
    })
  })

  describe('/api/workspaces', () => {
    it('lists workspaces', async () => {
      const res = await fetch(url('/api/workspaces'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { workspaces: Array<{ id: string }> }
      expect(body.workspaces.some((w) => w.id === 'default')).toBe(true)
    })
  })

  describe('POST /api/notify', () => {
    it('rejects missing fields with 400', async () => {
      const res = await fetch(url('/api/notify'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'rest-msg' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown platform', async () => {
      const res = await fetch(url('/api/notify'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'made-up', threadId: 't', text: 'hi' }),
      })
      expect(res.status).toBe(404)
    })

    it('forwards text to the registered messenger', async () => {
      captured.length = 0
      const res = await fetch(url('/api/notify'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'rest-msg', threadId: 't-notify', text: 'hello-team' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; traceId: string }
      expect(body.ok).toBe(true)
      expect(body.traceId).toBeTruthy()
      expect(captured).toHaveLength(1)
      expect(captured[0]).toEqual({ threadId: 't-notify', text: 'hello-team' })
    })
  })

  describe('POST /api/invoke', () => {
    it('runs the default agent and returns text', async () => {
      const res = await fetch(url('/api/invoke'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello', agent: 'rest-stub' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; traceId: string; output: { content: string } }
      expect(body.ok).toBe(true)
      expect(body.traceId).toBeTruthy()
      expect(body.output.content).toContain('rest-stub-reply')
    })

    it('rejects missing prompt with 400', async () => {
      const res = await fetch(url('/api/invoke'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'rest-stub' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('body size cap', () => {
    it('rejects oversized POST with 413', async () => {
      const huge = 'x'.repeat(2 * 1024 * 1024)
      const res = await fetch(url('/api/invoke'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: huge }),
      })
      expect(res.status).toBe(413)
    })
  })

  describe('POST /api/agents/acp/discover', () => {
    it('rejects missing baseUrl with 400', async () => {
      const res = await fetch(url('/api/agents/acp/discover'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('returns error JSON on unreachable host', async () => {
      const res = await fetch(url('/api/agents/acp/discover'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1' }),
      })
      // Either 500 (network error) or 200 with ok:false depending on the
      // server's error mapping — both valid as long as no agent registered.
      expect([200, 500]).toContain(res.status)
    })
  })

  describe('Jobs API (W-1)', () => {
    it('GET /api/jobs returns shape under SQLite-degraded bun', async () => {
      const res = await fetch(url('/api/jobs'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { jobs: unknown[]; stats: { total: number } }
      expect(Array.isArray(body.jobs)).toBe(true)
      expect(typeof body.stats.total).toBe('number')
    })

    it('GET /api/jobs?status=pending&limit=10 accepts filters', async () => {
      const res = await fetch(url('/api/jobs?status=pending&limit=10'), { headers: auth })
      expect(res.status).toBe(200)
    })

    it('GET /api/jobs/:id returns 404 for unknown id', async () => {
      const res = await fetch(url('/api/jobs/999999999'), { headers: auth })
      expect(res.status).toBe(404)
    })

    it('POST /api/jobs/:id/cancel returns 200 with ok flag', async () => {
      const res = await fetch(url('/api/jobs/999999999/cancel'), {
        method: 'POST', headers: auth,
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(typeof body.ok).toBe('boolean')
    })

    it('POST /api/jobs/:id/run on missing job returns 404', async () => {
      const res = await fetch(url('/api/jobs/999999999/run'), {
        method: 'POST', headers: auth,
      })
      expect(res.status).toBe(404)
    })

    it('POST /api/jobs rejects missing fields with 400', async () => {
      const res = await fetch(url('/api/jobs'), {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('POST /api/jobs rejects unknown agent with 404', async () => {
      const res = await fetch(url('/api/jobs'), {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'made-up', prompt: 'hello' }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('Schedules API (W-1)', () => {
    it('GET /api/schedules returns an array', async () => {
      const res = await fetch(url('/api/schedules'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { schedules: unknown[] }
      expect(Array.isArray(body.schedules)).toBe(true)
    })
  })

  describe('Static tasks page', () => {
    it('GET /tasks serves an HTML page with auth-token injected', async () => {
      const res = await fetch(url('/tasks'))
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('IMHUB_TOKEN')
      expect(text).toContain('Tasks')
    })
  })

  describe('/api/bgjobs', () => {
    // We point IMHUB_BGJOB_ROOTS at temp dirs we lay out ourselves so this
    // test never touches the real ~/.claude/bgjobs.
    let bgTmpA: string
    let bgTmpB: string
    const ORIGINAL = process.env.IMHUB_BGJOB_ROOTS

    beforeAll(async () => {
      const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: pjoin } = await import('path')
      bgTmpA = mkdtempSync(pjoin(tmpdir(), 'bgjobs-A-'))
      bgTmpB = mkdtempSync(pjoin(tmpdir(), 'bgjobs-B-'))
      // root A: 2 jobs in index
      writeFileSync(pjoin(bgTmpA, 'index.json'), JSON.stringify({
        jobs: [{ id: 'jA1' }, { id: 'jA2' }],
      }))
      mkdirSync(pjoin(bgTmpA, 'jA1'))
      writeFileSync(pjoin(bgTmpA, 'jA1', 'meta.json'), JSON.stringify({
        id: 'jA1', name: 'task-A1', status: 'running', pid: 11,
        started_at: '2026-05-01T08:00:00+08:00', exit_code: null, ended_at: null,
      }))
      writeFileSync(pjoin(bgTmpA, 'jA1', 'log.txt'), 'a-line-1\na-line-2\n')
      mkdirSync(pjoin(bgTmpA, 'jA2'))
      writeFileSync(pjoin(bgTmpA, 'jA2', 'meta.json'), JSON.stringify({
        id: 'jA2', name: 'task-A2', status: 'completed', pid: 12,
        started_at: '2026-05-01T09:00:00+08:00', ended_at: '2026-05-01T09:01:00+08:00',
        exit_code: 0,
      }))
      // root B: 1 job
      mkdirSync(pjoin(bgTmpB, 'jB1'))
      writeFileSync(pjoin(bgTmpB, 'jB1', 'meta.json'), JSON.stringify({
        id: 'jB1', name: 'task-B1', status: 'failed', pid: 99,
        started_at: '2026-05-01T07:00:00+08:00', ended_at: '2026-05-01T07:00:30+08:00',
        exit_code: 1,
      }))
      process.env.IMHUB_BGJOB_ROOTS = `rootA=${bgTmpA},rootB=${bgTmpB}`
    })

    afterAll(async () => {
      const { rmSync } = await import('fs')
      rmSync(bgTmpA, { recursive: true, force: true })
      rmSync(bgTmpB, { recursive: true, force: true })
      if (ORIGINAL === undefined) delete process.env.IMHUB_BGJOB_ROOTS
      else process.env.IMHUB_BGJOB_ROOTS = ORIGINAL
    })

    it('GET /api/bgjobs returns groups across all roots', async () => {
      const res = await fetch(url('/api/bgjobs'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { roots: Array<{ id: string }>; groups: Array<{ rootId: string; jobs: unknown[] }> }
      const rootIds = body.roots.map((r) => r.id).sort()
      expect(rootIds).toEqual(['rootA', 'rootB'])
      const byId = Object.fromEntries(body.groups.map((g) => [g.rootId, g.jobs]))
      expect(byId.rootA.length).toBe(2)
      expect(byId.rootB.length).toBe(1)
    })

    it('GET /api/bgjobs?root=rootA returns just that root', async () => {
      const res = await fetch(url('/api/bgjobs?root=rootA'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { jobs: Array<{ id: string; rootId: string }> }
      expect(body.jobs.length).toBe(2)
      expect(body.jobs.every((j) => j.rootId === 'rootA')).toBe(true)
    })

    it('GET /api/bgjobs?root=missing returns 404', async () => {
      const res = await fetch(url('/api/bgjobs?root=nope'), { headers: auth })
      expect(res.status).toBe(404)
    })

    it('GET /api/bgjobs/:id?root=rootA&tail=N returns detail with log tail', async () => {
      const res = await fetch(url('/api/bgjobs/jA1?root=rootA&tail=10'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { job: { id: string; log_tail: string; cmd: string[] } }
      expect(body.job.id).toBe('jA1')
      expect(body.job.log_tail).toContain('a-line-1')
      expect(body.job.log_tail).toContain('a-line-2')
    })

    it('GET /api/bgjobs/:id without root probes every configured root', async () => {
      const res = await fetch(url('/api/bgjobs/jB1'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { job: { id: string; rootId: string } }
      expect(body.job.id).toBe('jB1')
      expect(body.job.rootId).toBe('rootB')
    })

    it('GET /api/bgjobs/missing returns 404', async () => {
      const res = await fetch(url('/api/bgjobs/no-such-id'), { headers: auth })
      expect(res.status).toBe(404)
    })

    it('rejects without auth token', async () => {
      const res = await fetch(url('/api/bgjobs'))
      expect(res.status).toBe(401)
    })
  })

  describe('/api/subtasks', () => {
    it('GET returns the subtasks array', async () => {
      const res = await fetch(url('/api/subtasks'), { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as { subtasks: unknown[] }
      expect(Array.isArray(body.subtasks)).toBe(true)
    })

    it('rejects without auth token', async () => {
      const res = await fetch(url('/api/subtasks'))
      expect(res.status).toBe(401)
    })
  })
})
