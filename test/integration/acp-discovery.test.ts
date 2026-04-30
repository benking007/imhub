// Integration tests for ACP agent discovery via /.well-known/acp (A-1).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { discoverAgents, discoverMany } from '../../src/plugins/agents/acp/discovery'

let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || ''
    if (url === '/.well-known/acp') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        agents: [
          { name: 'good-agent', endpoint: 'http://example.com/good', aliases: ['g'] },
          { name: 'auth-agent', endpoint: 'http://example.com/auth',
            auth: { type: 'bearer', token: 'tok-123' } },
          { name: '', endpoint: 'http://no-name' },         // malformed (skipped)
          { name: 'no-endpoint' },                            // malformed (skipped)
          'not-an-object',                                    // malformed (skipped)
        ],
      }))
      return
    }
    if (url === '/empty/.well-known/acp') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ agents: [] }))
      return
    }
    if (url === '/bad/.well-known/acp') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{ "not_agents": [] }')
      return
    }
    if (url === '/500/.well-known/acp') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(() => {
  server?.close()
})

const base = (): string => `http://127.0.0.1:${port}`

describe('discoverAgents', () => {
  it('parses a valid well-known doc', async () => {
    const result = await discoverAgents(base())
    expect(result.agents).toHaveLength(2)
    expect(result.agents[0].name).toBe('good-agent')
    expect(result.agents[0].aliases).toEqual(['g'])
    expect(result.agents[1].auth?.type).toBe('bearer')
    expect(result.agents[1].auth?.token).toBe('tok-123')
  })

  it('skips malformed entries silently', async () => {
    const result = await discoverAgents(base())
    // 5 entries served, 3 are malformed → 2 valid
    expect(result.agents).toHaveLength(2)
  })

  it('strips trailing slashes from baseUrl', async () => {
    const result = await discoverAgents(base() + '////')
    expect(result.baseUrl).toBe(base())
  })

  it('handles empty agents array', async () => {
    const result = await discoverAgents(base() + '/empty')
    expect(result.agents).toEqual([])
  })

  it('throws on missing agents key', async () => {
    await expect(discoverAgents(base() + '/bad')).rejects.toThrow(/agents/i)
  })

  it('throws on non-2xx status', async () => {
    await expect(discoverAgents(base() + '/500')).rejects.toThrow(/Discovery failed/)
  })

  it('throws on connection refused', async () => {
    await expect(discoverAgents('http://127.0.0.1:1')).rejects.toThrow()
  })
})

describe('discoverMany', () => {
  it('returns partial results when some URLs fail', async () => {
    const results = await discoverMany([
      base(),
      'http://127.0.0.1:1',  // refused
      base() + '/empty',
    ])
    expect(results).toHaveLength(2)  // only successful ones
    const baseHit = results.find((r) => r.agents.length > 0)
    expect(baseHit?.agents).toHaveLength(2)
  })

  it('returns empty array when no URLs supplied', async () => {
    const results = await discoverMany([])
    expect(results).toEqual([])
  })
})
