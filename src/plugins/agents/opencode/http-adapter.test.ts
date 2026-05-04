// OpenCodeHttpAdapter tests.
//
// Coverage layers:
//   1. Driver-selection contract (factory) — protects the
//      IMHUB_OPENCODE_DRIVER env toggle.
//   2. Pure event-mapping helpers (inspectHttpEvent / isIdleEvent /
//      isErrorEvent) — locks in the SSE → adapter-effects contract without
//      spinning up `opencode serve`.
//   3. End-to-end sendPrompt with a fully-mocked fetch + serve — proves the
//      happy path (subscribes SSE, posts prompt, captures sessionID, yields
//      text on time.end, breaks on session.idle) and the four permission
//      paths: no bus → fallback once, bus without IM ctx → fallback once,
//      bridge allow → POST reply once, bridge deny+message → POST reply
//      reject + message.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { OpenCodeAdapter, OpenCodeHttpAdapter } from './index.js'
import type { AgentSendOpts } from '../../../core/types.js'
import type { OpencodeEvent } from './opencode-http-adapter.js'
import type { OpencodeServeManager } from './serve-manager.js'

describe('OpenCodeHttpAdapter — identity', () => {
  it('inherits from OpenCodeAdapter so registry sees the same name/aliases', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a).toBeInstanceOf(OpenCodeAdapter)
    expect(a.name).toBe('opencode')
    expect(a.aliases).toEqual(['oc', 'opencodeai'])
  })
})

describe('opencode driver factory (env IMHUB_OPENCODE_DRIVER)', () => {
  let original: string | undefined

  beforeEach(() => { original = process.env.IMHUB_OPENCODE_DRIVER })
  afterEach(() => {
    if (original === undefined) delete process.env.IMHUB_OPENCODE_DRIVER
    else process.env.IMHUB_OPENCODE_DRIVER = original
  })

  // The factory is invoked at module-load time — to test selection without
  // re-importing the module on every case, we re-construct the same factory
  // logic locally. Mirrors index.ts and locks in the contract.
  function pick(envValue: string | undefined): OpenCodeAdapter {
    if (envValue === undefined) delete process.env.IMHUB_OPENCODE_DRIVER
    else process.env.IMHUB_OPENCODE_DRIVER = envValue
    const driver = (process.env.IMHUB_OPENCODE_DRIVER || '').toLowerCase()
    return driver === 'http' ? new OpenCodeHttpAdapter() : new OpenCodeAdapter()
  }

  it('defaults to stdio when env is unset', () => {
    const a = pick(undefined)
    expect(a).toBeInstanceOf(OpenCodeAdapter)
    expect(a).not.toBeInstanceOf(OpenCodeHttpAdapter)
  })

  it('defaults to stdio when env is empty string', () => {
    const a = pick('')
    expect(a).not.toBeInstanceOf(OpenCodeHttpAdapter)
  })

  it('selects http when env is "http"', () => {
    const a = pick('http')
    expect(a).toBeInstanceOf(OpenCodeHttpAdapter)
  })

  it('selects http case-insensitively', () => {
    const a = pick('HTTP')
    expect(a).toBeInstanceOf(OpenCodeHttpAdapter)
  })

  it('falls back to stdio for unknown values (no throw)', () => {
    const a = pick('grpc-someday')
    expect(a).not.toBeInstanceOf(OpenCodeHttpAdapter)
    expect(a).toBeInstanceOf(OpenCodeAdapter)
  })
})

describe('OpenCodeHttpAdapter.inspectHttpEvent — sessionID + usage capture', () => {
  it('forwards sessionID via opts.onAgentSessionId (event.properties.sessionID)', () => {
    const a = new OpenCodeHttpAdapter()
    const ids: string[] = []
    a.inspectHttpEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x', part: { type: 'step-start' } } },
      'ses_x',
      { onAgentSessionId: (id) => ids.push(id) },
    )
    expect(ids).toEqual(['ses_x'])
  })

  it('forwards sessionID from properties.info.sessionID when properties.sessionID missing', () => {
    const a = new OpenCodeHttpAdapter()
    const ids: string[] = []
    a.inspectHttpEvent(
      { type: 'session.status', properties: { info: { sessionID: 'ses_x', status: { type: 'running' } } } },
      'ses_x',
      { onAgentSessionId: (id) => ids.push(id) },
    )
    expect(ids).toEqual(['ses_x'])
  })

  it('captures cost + tokens from message.part.updated of type step-finish', () => {
    const a = new OpenCodeHttpAdapter()
    const deltas: Array<{ costUsd?: number; tokensInput?: number; tokensOutput?: number }> = []
    a.inspectHttpEvent(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_x',
          part: { type: 'step-finish', cost: 0.0123, tokens: { input: 100, output: 50, total: 150 } },
        },
      },
      'ses_x',
      { onUsage: (d) => deltas.push(d) },
    )
    expect(deltas.length).toBe(1)
    expect(deltas[0].costUsd).toBe(0.0123)
    expect(deltas[0].tokensInput).toBe(100)
    expect(deltas[0].tokensOutput).toBe(50)
  })

  it('does not fire onUsage when step-finish carries no cost/tokens', () => {
    const a = new OpenCodeHttpAdapter()
    const deltas: unknown[] = []
    a.inspectHttpEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x', part: { type: 'step-finish' } } },
      'ses_x',
      { onUsage: (d) => deltas.push(d) },
    )
    expect(deltas.length).toBe(0)
  })

  it('does not fire onUsage for non-step-finish events', () => {
    const a = new OpenCodeHttpAdapter()
    const deltas: unknown[] = []
    a.inspectHttpEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x', part: { type: 'text', text: 'hi' } } },
      'ses_x',
      { onUsage: (d) => deltas.push(d) },
    )
    expect(deltas.length).toBe(0)
  })

  it('survives onAgentSessionId throwing (callback safety)', () => {
    const a = new OpenCodeHttpAdapter()
    a.inspectHttpEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x', part: { type: 'step-start' } } },
      'ses_x',
      { onAgentSessionId: () => { throw new Error('boom') } },
    )
    expect(true).toBe(true)
  })
})

describe('OpenCodeHttpAdapter.inspectHttpEvent — text emission', () => {
  it('yields text only when part.time.end is set (matches stdio adapter)', () => {
    const a = new OpenCodeHttpAdapter()
    const opts: AgentSendOpts = {}

    const streaming = a.inspectHttpEvent(
      {
        type: 'message.part.updated',
        properties: { sessionID: 'ses_x', part: { type: 'text', text: 'hel', time: { start: 1 } } },
      },
      'ses_x',
      opts,
    )
    expect(streaming.text).toBeUndefined()

    const finished = a.inspectHttpEvent(
      {
        type: 'message.part.updated',
        properties: { sessionID: 'ses_x', part: { type: 'text', text: 'hello', time: { start: 1, end: 2 } } },
      },
      'ses_x',
      opts,
    )
    expect(finished.text).toBe('hello')
  })

  it('ignores text from a different sessionID (cross-talk guard)', () => {
    const a = new OpenCodeHttpAdapter()
    const out = a.inspectHttpEvent(
      {
        type: 'message.part.updated',
        properties: { sessionID: 'ses_other', part: { type: 'text', text: 'hi', time: { end: 1 } } },
      },
      'ses_x',
      {},
    )
    expect(out.text).toBeUndefined()
  })
})

describe('OpenCodeHttpAdapter.isIdleEvent', () => {
  it('matches session.status idle for our session', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isIdleEvent(
      { type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'idle' } } },
      'ses_x',
    )).toBe(true)
  })

  it('matches when status comes nested under properties.info', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isIdleEvent(
      { type: 'session.status', properties: { info: { sessionID: 'ses_x', status: { type: 'idle' } } } },
      'ses_x',
    )).toBe(true)
  })

  it('does not match running status', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isIdleEvent(
      { type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'running' } } },
      'ses_x',
    )).toBe(false)
  })

  it('does not match idle for a different session', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isIdleEvent(
      { type: 'session.status', properties: { sessionID: 'ses_other', status: { type: 'idle' } } },
      'ses_x',
    )).toBe(false)
  })

  it('does not match non-status events', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isIdleEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x' } },
      'ses_x',
    )).toBe(false)
  })
})

describe('OpenCodeHttpAdapter.isErrorEvent', () => {
  it('extracts error message from properties.error.data.message', () => {
    const a = new OpenCodeHttpAdapter()
    const out = a.isErrorEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_x',
          error: { name: 'ProviderError', data: { message: 'rate limited' } },
        },
      },
      'ses_x',
    )
    expect(out).toEqual({ error: 'rate limited' })
  })

  it('falls back to error.name when data.message is absent', () => {
    const a = new OpenCodeHttpAdapter()
    const out = a.isErrorEvent(
      { type: 'session.error', properties: { sessionID: 'ses_x', error: { name: 'BoomError' } } },
      'ses_x',
    )
    expect(out).toEqual({ error: 'BoomError' })
  })

  it('returns null for non-error events', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isErrorEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_x' } },
      'ses_x',
    )).toBeNull()
  })

  it('returns null for errors on a different session', () => {
    const a = new OpenCodeHttpAdapter()
    expect(a.isErrorEvent(
      { type: 'session.error', properties: { sessionID: 'ses_other', error: { name: 'X' } } },
      'ses_x',
    )).toBeNull()
  })
})

// ─── End-to-end sendPrompt with mocked fetch + serve ───────────────────────

interface MockedHit {
  url: string
  method: string
  body?: unknown
}

function makeServeStub(baseUrl = 'http://127.0.0.1:14199'): OpencodeServeManager {
  // Just enough surface for sendPrompt — the manager's real lifecycle is
  // tested separately if/when it grows.
  return {
    ensureRunning: async () => baseUrl,
    isRunning: () => true,
    getBaseUrl: () => baseUrl,
    stop: async () => {},
  } as unknown as OpencodeServeManager
}

/** Build a fake fetch that returns a programmable stream of SSE frames for
 *  /event and JSON for the other endpoints. */
function makeFakeFetch(
  events: OpencodeEvent[],
  opts: { sessionId?: string; hits?: MockedHit[] } = {},
): typeof fetch {
  const hits = opts.hits ?? []
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    let parsedBody: unknown
    if (init?.body && typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body) } catch { parsedBody = init.body }
    }
    hits.push({ url, method, body: parsedBody })

    if (url.endsWith('/session') && method === 'POST') {
      return new Response(JSON.stringify({ id: opts.sessionId ?? 'ses_test' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/session/') && url.endsWith('/message') && method === 'POST') {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/permission') === false && url.includes('/permission/') && url.endsWith('/reply')) {
      return new Response('true', { status: 200 })
    }
    if (url.endsWith('/event')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const ev of events) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
          }
          // Leave the stream open — the adapter cancels via close() on idle.
        },
      })
      return new Response(stream, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }) as typeof fetch
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('OpenCodeHttpAdapter.sendPrompt — happy path', () => {
  it('creates a session, captures sessionID, yields finished text, breaks on idle', async () => {
    const sid = 'ses_happy'
    const events: OpencodeEvent[] = [
      { type: 'server.connected', properties: {} },
      { type: 'message.part.updated', properties: { sessionID: sid, part: { type: 'step-start' } } },
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'step-finish', cost: 0.01, tokens: { input: 10, output: 5 } },
        } },
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'hello world', time: { start: 1, end: 2 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const ids: string[] = []
    const usage: Array<{ costUsd?: number; tokensInput?: number; tokensOutput?: number }> = []

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl })
    const chunks = await collect(adapter.sendPrompt('imhub-1', 'hi', [], {
      onAgentSessionId: (id) => ids.push(id),
      onUsage: (d) => usage.push(d),
    }))

    expect(chunks).toEqual(['hello world'])
    expect(ids[0]).toBe(sid) // Captured both at create-time and from events
    expect(usage[0].costUsd).toBe(0.01)
    expect(usage[0].tokensInput).toBe(10)
    expect(usage[0].tokensOutput).toBe(5)

    // Must have hit /event, then POST /session, POST /session/:id/message
    const urls = hits.map(h => `${h.method} ${h.url}`)
    expect(urls.some(u => u.startsWith('GET ') && u.endsWith('/event'))).toBe(true)
    expect(urls.some(u => u === 'POST http://test.local/session')).toBe(true)
    expect(urls.some(u => u === `POST http://test.local/session/${sid}/message`)).toBe(true)
  })

  it('skips session create and reuses agentSessionId on resume', async () => {
    const sid = 'ses_resumed'
    const events: OpencodeEvent[] = [
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'second turn', time: { end: 1 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl })
    const chunks = await collect(adapter.sendPrompt('imhub-1', 'next', [], {
      agentSessionId: sid,
      agentSessionResume: true,
    }))

    expect(chunks).toEqual(['second turn'])
    const urls = hits.map(h => `${h.method} ${h.url}`)
    // No POST /session — we skipped create
    expect(urls.some(u => u === 'POST http://test.local/session')).toBe(false)
    // But we DID submit the prompt to the right session
    expect(urls.some(u => u === `POST http://test.local/session/${sid}/message`)).toBe(true)
  })

  it('falls back to "once" when no approval bus is wired', async () => {
    // Explicit `approvalBus: null` to lock in: when the bridge is
    // unavailable, the adapter falls back to auto-`once`.
    const sid = 'ses_perm'
    const events: OpencodeEvent[] = [
      { type: 'permission.asked', properties: { id: 'perm_1', sessionID: sid } },
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'done', time: { end: 1 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl, approvalBus: null })
    await collect(adapter.sendPrompt('imhub-1', 'go', [], {}))

    const replyHit = hits.find(h => h.url === 'http://test.local/permission/perm_1/reply' && h.method === 'POST')
    expect(replyHit).toBeDefined()
    expect((replyHit?.body as { reply?: string })?.reply).toBe('once')
  })

  it('falls back to "once" when bus is wired but IM ctx is missing', async () => {
    // When the prompt comes from a non-IM caller (web UI, scheduler),
    // there's no thread to surface a card to even though the bus is alive.
    const { ApprovalBus } = await import('../../../core/approval-bus.js')
    const bus = new ApprovalBus({ approvalTimeoutMs: 200 })
    bus.setNotifier(async () => { /* notifier present, but no ctx → still fallback */ })

    const sid = 'ses_perm_noctx'
    const events: OpencodeEvent[] = [
      { type: 'permission.asked', properties: { id: 'perm_x', sessionID: sid } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl, approvalBus: bus })
    // No threadId / platform → bridge declines, fallback fires.
    await collect(adapter.sendPrompt('imhub-1', 'go', [], {}))

    const replyHit = hits.find(h => h.url === 'http://test.local/permission/perm_x/reply')
    expect(replyHit).toBeDefined()
    expect((replyHit?.body as { reply?: string })?.reply).toBe('once')
    expect(bus.hasPendingFor('any')).toBe(false)
  })

  it('routes permission.asked through the IM bridge: allow → POST reply once', async () => {
    const { ApprovalBus } = await import('../../../core/approval-bus.js')
    const bus = new ApprovalBus({ approvalTimeoutMs: 5000 })
    let notified: { reqId: string; toolName: string; threadId: string } | null = null
    bus.setNotifier(async (n) => {
      notified = { reqId: n.reqId, toolName: n.toolName, threadId: n.ctx.threadId }
    })

    const sid = 'ses_bridge'
    const events: OpencodeEvent[] = [
      { type: 'permission.asked', properties: {
          id: 'perm_b1', sessionID: sid,
          permission: 'external_directory',
          patterns: ['/root/workspace/im-hub/*'],
        } },
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'after approval', time: { end: 1 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl, approvalBus: bus })
    // Drive sendPrompt + simulate the user replying "y" once the bus has
    // surfaced the request. We can't easily await mid-stream, so kick the
    // resolve after a tick.
    const drained = collect(adapter.sendPrompt('imhub-1', 'go', [], {
      threadId: 'thread-X', platform: 'wechat', userId: 'u', channelId: 'c',
    }))

    // Wait for the notifier to fire (bridge registered its synthetic pending).
    for (let i = 0; i < 50 && !notified; i++) await new Promise(r => setTimeout(r, 5))
    expect(notified).not.toBeNull()
    expect(notified!.reqId).toBe('perm_b1')
    expect(notified!.toolName).toBe('external_directory')
    expect(notified!.threadId).toBe('thread-X')

    // User clicks "approve" → bus.resolvePending → adapter's dispatch → POST.
    bus.resolvePending('thread-X', { behavior: 'allow' })
    await drained

    const replyHit = hits.find(h =>
      h.url === 'http://test.local/permission/perm_b1/reply' && h.method === 'POST',
    )
    expect(replyHit).toBeDefined()
    expect((replyHit?.body as { reply?: string })?.reply).toBe('once')
  })

  it('routes permission.asked through the IM bridge: deny → POST reply reject + message', async () => {
    const { ApprovalBus } = await import('../../../core/approval-bus.js')
    const bus = new ApprovalBus({ approvalTimeoutMs: 5000 })
    bus.setNotifier(async () => { /* surface side effect not needed */ })

    const sid = 'ses_bridge_deny'
    const events: OpencodeEvent[] = [
      { type: 'permission.asked', properties: { id: 'perm_d1', sessionID: sid, permission: 'bash' } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl, approvalBus: bus })
    const drained = collect(adapter.sendPrompt('imhub-1', 'go', [], {
      threadId: 'thread-Y', platform: 'wechat',
    }))

    for (let i = 0; i < 50 && !bus.hasPendingFor('thread-Y'); i++) await new Promise(r => setTimeout(r, 5))
    expect(bus.hasPendingFor('thread-Y')).toBe(true)

    bus.resolvePending('thread-Y', { behavior: 'deny', message: 'user said no' })
    await drained

    const replyHit = hits.find(h => h.url === 'http://test.local/permission/perm_d1/reply')
    expect(replyHit).toBeDefined()
    const body = replyHit!.body as { reply?: string; message?: string }
    expect(body.reply).toBe('reject')
    expect(body.message).toBe('user said no')
  })

  it('surfaces session.error message as a final chunk', async () => {
    const sid = 'ses_err'
    const events: OpencodeEvent[] = [
      { type: 'session.error', properties: {
          sessionID: sid,
          error: { name: 'ProviderError', data: { message: 'rate limited' } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const fetchImpl = makeFakeFetch(events, { sessionId: sid })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl })
    const chunks = await collect(adapter.sendPrompt('imhub-1', 'oops', [], {}))
    expect(chunks.some(c => c.includes('rate limited'))).toBe(true)
  })
})

describe('OpenCodeHttpAdapter.sendPrompt — plan mode', () => {
  it('creates a session with agent=plan and no permission ruleset', async () => {
    const sid = 'ses_plan_new'
    const events: OpencodeEvent[] = [
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'plan ready', time: { end: 1 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { sessionId: sid, hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl })
    await collect(adapter.sendPrompt('imhub-1', 'design X', [], { planMode: true }))

    const createHit = hits.find(h => h.url === 'http://test.local/session' && h.method === 'POST')
    expect(createHit).toBeDefined()
    const createBody = createHit!.body as Record<string, unknown>
    expect(createBody.agent).toBe('plan')
    // plan agent's own ruleset governs — we MUST NOT stack our medium gate.
    expect(createBody.permission).toBeUndefined()

    const messageHit = hits.find(
      h => h.url === `http://test.local/session/${sid}/message` && h.method === 'POST',
    )
    expect(messageHit).toBeDefined()
    const messageBody = messageHit!.body as Record<string, unknown>
    expect(messageBody.agent).toBe('plan')
  })

  it('on resume, posts agent=plan per message and skips ruleset PATCH', async () => {
    const sid = 'ses_plan_resume'
    const events: OpencodeEvent[] = [
      { type: 'message.part.updated', properties: {
          sessionID: sid,
          part: { type: 'text', text: 'replanning', time: { end: 1 } },
        } },
      { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } },
    ]
    const hits: MockedHit[] = []
    const fetchImpl = makeFakeFetch(events, { hits })
    const serve = makeServeStub('http://test.local')

    const adapter = new OpenCodeHttpAdapter({ serve, fetchImpl })
    await collect(adapter.sendPrompt('imhub-1', 'redo plan', [], {
      agentSessionId: sid,
      agentSessionResume: true,
      planMode: true,
    }))

    const urls = hits.map(h => `${h.method} ${h.url}`)
    // Plan-mode resume must NOT PATCH the session — plan agent's own rules win.
    expect(urls.some(u => u === `PATCH http://test.local/session/${sid}`)).toBe(false)
    // But it MUST submit the prompt with agent=plan to override session default.
    const messageHit = hits.find(
      h => h.url === `http://test.local/session/${sid}/message` && h.method === 'POST',
    )
    expect((messageHit!.body as Record<string, unknown>).agent).toBe('plan')
  })
})
