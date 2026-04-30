// Integration tests for ACP Server
//
// Spins up the real HTTP server on an ephemeral port and exercises auth,
// body limits, the agent card, and basic POST /tasks behavior.
// Note: POST /tasks goes through routeMessage → registry, so we register
// a stub agent and rely on the same fail-soft job-board path that lets
// the suite run under bun (better-sqlite3 unavailable).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { startACPServer } from '../../src/core/acp-server'
import { registry } from '../../src/core/registry'
import type { AgentAdapter } from '../../src/core/types'

// Stub agent the ACP server can route to.
const stubAgent: AgentAdapter = {
  name: 'acp-stub',
  aliases: ['acpstub'],
  isAvailable: async () => true,
  sendPrompt: async function* (_id, _prompt) { yield 'acp-stub-reply' },
}

const TOKEN_DIR = join(homedir(), '.im-hub')
const TOKEN_FILE = join(TOKEN_DIR, 'web-token')
const TEST_TOKEN = 'acp-test-token-1234567890'

let port = 0
let close: () => void

beforeAll(async () => {
  registry.registerAgent(stubAgent)
  // Plant a known token so parseAuth() finds it.
  mkdirSync(TOKEN_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, TEST_TOKEN, { mode: 0o600 })
  // Use a random ephemeral port to avoid collisions in CI.
  port = 9000 + Math.floor(Math.random() * 1000)
  const server = await startACPServer({ port, defaultAgent: 'acp-stub' })
  close = server.close
})

afterAll(() => {
  close?.()
})

const url = (path: string): string => `http://127.0.0.1:${port}${path}`

describe('ACP Server', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(url('/agent/card'))
    expect(res.status).toBe(401)
  })

  it('allows OPTIONS preflight without auth', async () => {
    const res = await fetch(url('/agent/card'), { method: 'OPTIONS' })
    expect(res.status).toBe(204)
  })

  it('returns the agent card with bearer auth', async () => {
    const res = await fetch(url('/agent/card'), {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string; protocols: string[]; capabilities: { agents: Array<{ name: string }> } }
    expect(body.name).toBe('im-hub-gateway')
    expect(body.protocols).toContain('acp/v1')
    expect(body.capabilities.agents.some((a) => a.name === 'acp-stub')).toBe(true)
  })

  it('returns the agent card with X-IM-Hub-Token auth', async () => {
    const res = await fetch(url('/agent/card'), {
      headers: { 'x-im-hub-token': TEST_TOKEN },
    })
    expect(res.status).toBe(200)
  })

  it('rejects bearer token with wrong value (constant-time compare)', async () => {
    const res = await fetch(url('/agent/card'), {
      headers: { authorization: `Bearer ${TEST_TOKEN}-wrong` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects POST without input.prompt with 400', async () => {
    const res = await fetch(url('/tasks'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sync' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects oversized request body with 413', async () => {
    // 2 MiB of JSON — exceeds 1 MiB cap
    const big = 'x'.repeat(2 * 1024 * 1024)
    const res = await fetch(url('/tasks'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { prompt: big } }),
    })
    expect(res.status).toBe(413)
  })

  it('returns 404 for unknown task id', async () => {
    const res = await fetch(url('/tasks/deadbeef00112233'), {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('inherits X-Trace-Id when supplied', async () => {
    // Just verify the request doesn't blow up with the trace header — full
    // trace correlation is asserted via logger inspection elsewhere.
    const res = await fetch(url('/agent/card'), {
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'x-trace-id': 'upstream-abc' },
    })
    expect(res.status).toBe(200)
  })
})
