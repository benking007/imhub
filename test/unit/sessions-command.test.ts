// Unit tests for /sessions — verifies graceful handling of dashboard
// failures (timeout / refused / non-JSON) and IM_HUB_DASHBOARD_URL
// override.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createServer, type Server } from 'http'
import { handleSessionsCommand } from '../../src/core/commands/sessions'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

const ctx: RouteContext = {
  platform: 'test', channelId: 'c', threadId: 't',
  defaultAgent: 'opencode', traceId: 'tr', logger: noopLogger, userId: 'u',
}

let server: Server
let port = 0
let mode: 'ok' | 'empty' | 'bad-json' | 'slow' | 'refused' = 'ok'
const ORIG_URL = process.env.IM_HUB_DASHBOARD_URL

beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === 'slow') {
      // Never respond — let the client time out
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (mode === 'bad-json') {
      res.end('not-json {')
      return
    }
    if (mode === 'empty') {
      res.end(JSON.stringify({ sessions: [] }))
      return
    }
    res.end(JSON.stringify({
      sessions: [
        { title: 'first', created: new Date().toISOString(), msgCount: 12, ageHours: 0.5 },
        { title: 'second', created: new Date().toISOString(), msgCount: 3, ageHours: 5 },
      ],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(() => {
  server?.close()
  if (ORIG_URL === undefined) delete process.env.IM_HUB_DASHBOARD_URL
  else process.env.IM_HUB_DASHBOARD_URL = ORIG_URL
})

beforeEach(() => {
  process.env.IM_HUB_DASHBOARD_URL = `http://127.0.0.1:${port}`
})

afterEach(() => {
  mode = 'ok'
})

describe('/sessions', () => {
  it('lists sessions on a healthy dashboard', async () => {
    mode = 'ok'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('first')
    expect(out).toContain('second')
  })

  it('shows empty when dashboard returns no sessions', async () => {
    mode = 'empty'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('暂无活跃会话')
  })

  it('reports refused when dashboard host is unreachable', async () => {
    process.env.IM_HUB_DASHBOARD_URL = 'http://127.0.0.1:1'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('无法连接')
  })

  it('reports timeout when dashboard does not respond', async () => {
    mode = 'slow'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('超时')
  }, 10_000)

  it('reports invalid JSON on garbage response', async () => {
    mode = 'bad-json'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('非 JSON')
  })

  it('honors IM_HUB_DASHBOARD_URL override', async () => {
    process.env.IM_HUB_DASHBOARD_URL = 'http://127.0.0.1:1'
    const out = await handleSessionsCommand('', ctx)
    expect(out).toContain('http://127.0.0.1:1')
  })
})
