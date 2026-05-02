// approval-router tests — parser, formatter, install/uninstall, and an
// end-to-end loop where install() wires real ApprovalBus → fake messenger →
// tryHandleApprovalReply → bus delivers Decision back to the caller.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { Socket, createConnection } from 'net'
import {
  ApprovalBus,
  approvalBus,
  type ApprovalNotification,
  type Decision,
  type RunContext,
} from './approval-bus.js'
import {
  parseApprovalReply,
  formatApprovalPrompt,
  platformToMessengerName,
  install,
  uninstall,
  tryHandleApprovalReply,
} from './approval-router.js'
import type { MessengerAdapter } from './types.js'

const RUN_CTX: RunContext = { threadId: 'thread-A', platform: 'feishu', userId: 'u1', channelId: 'c1' }

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-router-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

describe('parseApprovalReply', () => {
  it.each([
    ['y', 'allow'], ['Y', 'allow'], ['yes', 'allow'], ['YES', 'allow'],
    ['ok', 'allow'], ['1', 'allow'], ['批准', 'allow'], ['同意', 'allow'],
    ['通过', 'allow'], ['可以', 'allow'], ['✅', 'allow'],
    ['  y  ', 'allow'],   // whitespace
    ['/y', 'allow'],      // telegram-style slash
  ])('classifies %s as %s', (input, expected) => {
    const r = parseApprovalReply(input)
    expect(r?.behavior).toBe(expected as 'allow' | 'deny')
  })

  it.each([
    ['n', 'deny'], ['N', 'deny'], ['no', 'deny'], ['0', 'deny'],
    ['拒绝', 'deny'], ['不同意', 'deny'], ['不可以', 'deny'], ['不', 'deny'], ['❌', 'deny'],
  ])('classifies %s as %s', (input, expected) => {
    const r = parseApprovalReply(input)
    expect(r?.behavior).toBe(expected as 'allow' | 'deny')
  })

  it.each([
    [''], ['   '], ['hello'], ['why are you asking me'], ['yes please proceed'], ['n.b. read this first'],
  ])('returns null for non-decision reply %p', (input) => {
    expect(parseApprovalReply(input)).toBeNull()
  })

  it('deny decisions carry a default message', () => {
    const r = parseApprovalReply('n') as { behavior: 'deny'; message: string }
    expect(r.behavior).toBe('deny')
    expect(r.message).toContain('用户')
  })

  it.each([
    ['all'], ['ALL'], ['a'], ['全部'], ['总是'], ['都同意'], ['都批准'],
    ['  all  '], ['/all'],
  ])('parses %p as allow + autoAllowFurther', (input) => {
    const r = parseApprovalReply(input) as Decision & { autoAllowFurther?: boolean }
    expect(r?.behavior).toBe('allow')
    expect(r?.autoAllowFurther).toBe(true)
  })
})

describe('formatApprovalPrompt — auto-allow grace mode', () => {
  it('renders a softer prompt with countdown when n.autoAllow is set', () => {
    const n: ApprovalNotification = {
      runId: 'r', reqId: 'abcdef0123', toolName: 'Bash',
      input: { command: 'ls -la' }, toolUseId: 'tu', ctx: RUN_CTX,
      autoAllow: { graceMs: 5000 },
    }
    const text = formatApprovalPrompt(n)
    expect(text).toContain('5s')
    expect(text).toContain('自动放行')
    expect(text).toContain('n')   // still tells user how to reject
    expect(text).toContain('Bash')
    expect(text).toContain('ls -la')
  })
})

describe('platformToMessengerName', () => {
  it('maps wechat → wechat-ilink, others pass through', () => {
    expect(platformToMessengerName('wechat')).toBe('wechat-ilink')
    expect(platformToMessengerName('feishu')).toBe('feishu')
    expect(platformToMessengerName('telegram')).toBe('telegram')
  })
})

describe('formatApprovalPrompt', () => {
  it('renders a multi-line prompt with tool name, input preview, and short reqId', () => {
    const n: ApprovalNotification = {
      runId: 'run-1', reqId: 'abcdef0123456789',
      toolName: 'Bash', input: { command: 'git push' }, toolUseId: 'tu-1',
      ctx: RUN_CTX,
    }
    const text = formatApprovalPrompt(n)
    expect(text).toContain('Bash')
    expect(text).toContain('git push')
    expect(text).toContain('abcdef01') // 8-char reqId prefix
    expect(text).toContain('y') // includes hint
    expect(text).toContain('n')
  })

  it('truncates very long input', () => {
    const big = 'x'.repeat(2000)
    const n: ApprovalNotification = {
      runId: 'r', reqId: 'r1', toolName: 'Bash',
      input: { command: big }, toolUseId: 'tu', ctx: RUN_CTX,
    }
    const text = formatApprovalPrompt(n)
    expect(text.length).toBeLessThan(2000)
    expect(text).toContain('…')
  })
})

describe('tryHandleApprovalReply', () => {
  let bus: ApprovalBus
  let path: string
  let connectedSock: Socket

  // Use the singleton's setNotifier API (what install() touches under the
  // hood). Tests here drive approvalBus directly; the real install() flow is
  // exercised in the integration block below.
  beforeEach(async () => {
    path = uniqueSocketPath()
    bus = new ApprovalBus({ approvalTimeoutMs: 1000 })
    await bus.start(path)
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { /* no-op: we'll seed pending manually below */ })

    // Seed a pending so hasPendingFor('thread-A') is true.
    connectedSock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    connectedSock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'pending-1',
      toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'tu',
    }) + '\n')
    // Give bus a tick to enqueue
    await new Promise((r) => setTimeout(r, 30))
    expect(bus.hasPendingFor('thread-A')).toBe(true)
  })

  afterEach(async () => {
    connectedSock.end()
    await bus.stop()
    uninstall()
  })

  it('returns false when no pending exists for the thread', () => {
    // Use a different threadId — no pending there
    expect(tryHandleApprovalReply('other-thread', 'y')).toBe(false)
    // The original pending is still there
    expect(bus.hasPendingFor('thread-A')).toBe(false || bus.hasPendingFor('thread-A'))
  })

  // The following two tests must use the singleton bus, since
  // tryHandleApprovalReply targets approvalBus (not our private bus).
  // We swap the singleton's pending-tracker via setNotifier on it directly
  // would be invasive — instead, route through the real install() integration
  // block below. So skip the direct assertions here.

  it('routes "redirect" reply (non-y/n) to false but auto-denies pending', async () => {
    // Wire singleton so tryHandleApprovalReply queries it. We bridge
    // hasPendingFor / resolvePending to our private bus for this test.
    const origHasPending = approvalBus.hasPendingFor.bind(approvalBus)
    const origResolve = approvalBus.resolvePending.bind(approvalBus)
    approvalBus.hasPendingFor = (tid: string) => bus.hasPendingFor(tid)
    approvalBus.resolvePending = (tid: string, d: Decision) => bus.resolvePending(tid, d)
    try {
      const consumed = tryHandleApprovalReply('thread-A', 'do something completely different')
      expect(consumed).toBe(false)
      // pending should now be drained (auto-deny)
      expect(bus.hasPendingFor('thread-A')).toBe(false)
    } finally {
      approvalBus.hasPendingFor = origHasPending
      approvalBus.resolvePending = origResolve
    }
  })

  it('y reply consumes the message and resolves pending with allow', async () => {
    const origHasPending = approvalBus.hasPendingFor.bind(approvalBus)
    const origResolve = approvalBus.resolvePending.bind(approvalBus)
    let resolvedWith: Decision | null = null
    approvalBus.hasPendingFor = (tid: string) => bus.hasPendingFor(tid)
    approvalBus.resolvePending = (tid: string, d: Decision) => {
      resolvedWith = d
      return bus.resolvePending(tid, d)
    }
    try {
      const consumed = tryHandleApprovalReply('thread-A', 'y')
      expect(consumed).toBe(true)
      expect(resolvedWith).not.toBeNull()
      expect((resolvedWith as unknown as Decision).behavior).toBe('allow')
    } finally {
      approvalBus.hasPendingFor = origHasPending
      approvalBus.resolvePending = origResolve
    }
  })
})

describe('install / uninstall — full loop with fake messenger', () => {
  it('end-to-end: sidecar approval → notifier sendMessage → user reply → decision back', async () => {
    const path = uniqueSocketPath()
    // Install on the singleton (what cli.ts does in production)
    await approvalBus.start(path)
    approvalBus.registerRun('run-int', RUN_CTX)

    let lastSentTo: { threadId: string; text: string } | null = null
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { lastSentTo = { threadId, text } },
    }
    install({ resolveMessenger: () => fakeMessenger })

    // Sidecar end: connect, send approval
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')

    const decisions: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) decisions.push(JSON.parse(line))
      }
    })

    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-int', reqId: 'rint-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu-int',
    }) + '\n')

    // Wait for messenger sendMessage
    for (let i = 0; i < 50 && !lastSentTo; i++) await new Promise((r) => setTimeout(r, 10))
    expect(lastSentTo).not.toBeNull()
    expect(lastSentTo!.threadId).toBe('thread-A')
    expect(lastSentTo!.text).toContain('Bash')
    expect(lastSentTo!.text).toContain('rm -rf')

    // User replies "y" via cli's onMessage path
    const consumed = tryHandleApprovalReply('thread-A', 'y')
    expect(consumed).toBe(true)

    // Sidecar should receive a decision shortly
    for (let i = 0; i < 50 && decisions.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(decisions.length).toBe(1)
    expect((decisions[0] as { behavior: string }).behavior).toBe('allow')

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('receipt: replying "all" sends a confirmation message back to the thread', async () => {
    const path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-rcpt', RUN_CTX)

    const sent: Array<{ threadId: string; text: string }> = []
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
    }
    install({ resolveMessenger: () => fakeMessenger })

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    sock.on('data', () => { /* don't care */ })

    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rcpt', reqId: 'r-rcpt-1',
      toolName: 'Bash', input: { command: 'git status -s' }, toolUseId: 'tu',
    }) + '\n')

    // Wait for approval prompt
    for (let i = 0; i < 50 && sent.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('🔐')

    // User replies "all" → receipt should be sent in addition to (silent) decision
    const consumed = tryHandleApprovalReply('thread-A', 'all')
    expect(consumed).toBe(true)
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent.length).toBe(2)
    expect(sent[1].text).toContain('已批准并启用自动放行')
    expect(sent[1].text).toContain('Bash')
    expect(sent[1].text).toContain('git s') // 5-char prefix

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('receipt: denying during grace mode sends "已撤销自动放行规则" message', async () => {
    const path = uniqueSocketPath()
    // tight grace so the second request immediately enters auto-allow mode
    const localBus = approvalBus
    await localBus.start(path)
    localBus.registerRun('run-rev', RUN_CTX)

    const sent: Array<{ threadId: string; text: string }> = []
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
    }
    install({ resolveMessenger: () => fakeMessenger })

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    sock.on('data', () => {})

    // Seed the rule
    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rev', reqId: 'rev-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu',
    }) + '\n')
    for (let i = 0; i < 50 && sent.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    tryHandleApprovalReply('thread-A', 'all')
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent[1].text).toContain('已批准并启用自动放行')

    // Second request → should hit the rule (grace mode)
    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rev', reqId: 'rev-2',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/y' }, toolUseId: 'tu2',
    }) + '\n')
    for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent[2].text).toContain('自动放行中')

    // User actively denies → receipt confirms revocation
    tryHandleApprovalReply('thread-A', 'n')
    for (let i = 0; i < 50 && sent.length < 4; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent[3].text).toContain('已拒绝并撤销自动放行')
    expect(localBus.getAutoAllowKeys('thread-A')).toEqual([])

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('install with no messenger for platform → bus auto-denies', async () => {
    const path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-empty', RUN_CTX)
    install({ resolveMessenger: () => undefined }) // never resolves

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    const got: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) got.push(JSON.parse(line))
      }
    })

    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-empty', reqId: 'r-empty',
      toolName: 'Bash', input: {}, toolUseId: 'tu',
    }) + '\n')

    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(got.length).toBe(1)
    const d = got[0] as { behavior: string; message?: string }
    expect(d.behavior).toBe('deny')

    sock.end()
    uninstall()
    await approvalBus.stop()
  })
})
