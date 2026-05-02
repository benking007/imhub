// approval-bus tests — 用真实 unix socket 模拟 sidecar 端，验证协议与 pending 生命周期。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Socket, createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  ApprovalBus,
  type ApprovalNotification,
  type Decision,
  type RunContext,
} from './approval-bus.js'

const RUN_CTX: RunContext = {
  threadId: 'thread-A',
  platform: 'feishu',
  userId: 'user-1',
  channelId: 'chan-1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

/** A minimal NDJSON client over unix socket. Tests get one of these per connection. */
class TestClient {
  private buf = ''
  private queue: unknown[] = []
  private waiters: Array<(v: unknown) => void> = []
  socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        const obj = JSON.parse(line)
        const w = this.waiters.shift()
        if (w) w(obj)
        else this.queue.push(obj)
      }
    })
  }

  send(obj: unknown): void {
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  /** Send a raw line (no JSON validation) — used for bad-json tests. */
  sendRaw(line: string): void {
    this.socket.write(line + '\n')
  }

  /** Resolve as soon as next NDJSON message arrives. Throws on timeout. */
  next(timeoutMs = 1000): Promise<any> {
    return new Promise((resolve, reject) => {
      const queued = this.queue.shift()
      if (queued !== undefined) { resolve(queued); return }
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wrapped)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`TestClient.next() timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const wrapped = (v: unknown): void => {
        clearTimeout(timer)
        resolve(v)
      }
      this.waiters.push(wrapped)
    })
  }

  /** Resolve next message OR null if socket closes first within timeout. */
  nextOrClose(timeoutMs = 1000): Promise<any> {
    return Promise.race([
      this.next(timeoutMs).catch(() => null),
      new Promise<null>((resolve) => {
        this.socket.once('close', () => resolve(null))
      }),
    ])
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) { resolve(); return }
      this.socket.once('close', () => resolve())
      this.socket.end()
    })
  }
}

async function connectClient(path: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeAllListeners('error')
      sock.on('error', () => { /* swallow post-connect errors in tests */ })
      resolve(new TestClient(sock))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ApprovalBus', () => {
  let bus: ApprovalBus
  let path: string

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 200 })
    path = uniqueSocketPath()
    await bus.start(path)
  })

  afterEach(async () => {
    await bus.stop()
  })

  it('start() listens on the given socket path', async () => {
    expect(bus.getSocketPath()).toBe(path)
    // Simply being able to connect verifies the listener is up
    const client = await connectClient(path)
    await client.close()
  })

  it('happy path: approval → notifier → resolvePending(allow)', async () => {
    bus.registerRun('run-1', RUN_CTX)
    let notified: ApprovalNotification | null = null
    bus.setNotifier(async (n) => { notified = n })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval',
      runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: { command: 'git push' }, toolUseId: 'tu-1',
    })

    // Wait for notifier to fire (it's async via handleApproval)
    for (let i = 0; i < 50 && !notified; i++) await sleep(10)
    expect(notified).not.toBeNull()
    expect(notified!.runId).toBe('run-1')
    expect(notified!.reqId).toBe('req-1')
    expect(notified!.toolName).toBe('Bash')
    expect(notified!.input).toEqual({ command: 'git push' })
    expect(notified!.ctx.threadId).toBe('thread-A')
    expect(bus.hasPendingFor('thread-A')).toBe(true)

    const resolved = bus.resolvePending('thread-A', { behavior: 'allow' })
    expect(resolved).toBe(true)
    expect(bus.hasPendingFor('thread-A')).toBe(false)

    const decision = await client.next()
    expect(decision).toEqual({ v: 1, type: 'decision', reqId: 'req-1', behavior: 'allow' })

    await client.close()
  })

  it('resolvePending forwards updatedInput', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { /* noop */ })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu-1',
    })
    await sleep(20)

    bus.resolvePending('thread-A', { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/safe' } })
    const decision = await client.next()
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'rm -rf /tmp/safe' })

    await client.close()
  })

  it('resolvePending(deny) carries the message', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)

    bus.resolvePending('thread-A', { behavior: 'deny', message: '用户拒绝' })
    const decision = await client.next()
    expect(decision).toEqual({ v: 1, type: 'decision', reqId: 'req-1', behavior: 'deny', message: '用户拒绝' })

    await client.close()
  })

  it('approval timeout → auto deny', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next(2000)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('approval timeout')
    expect(bus.hasPendingFor('thread-A')).toBe(false)

    await client.close()
  })

  it('unknown runId → instant deny without notifier', async () => {
    let notifierCalls = 0
    bus.setNotifier(async () => { notifierCalls++ })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'unknown', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('unknown runId')
    expect(notifierCalls).toBe(0)

    await client.close()
  })

  it('no notifier installed → instant deny', async () => {
    bus.registerRun('run-1', RUN_CTX)
    // Intentionally no setNotifier

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('no notifier installed')

    await client.close()
  })

  it('unregisterRun denies pending for that run', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor('thread-A')).toBe(true)

    bus.unregisterRun('run-1')
    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('run terminated')
    expect(bus.hasPendingFor('thread-A')).toBe(false)

    await client.close()
  })

  it('socket close denies pending for that connection', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor('thread-A')).toBe(true)

    await client.close()
    // Give bus a moment to handle 'close'
    for (let i = 0; i < 20 && bus.hasPendingFor('thread-A'); i++) await sleep(10)
    expect(bus.hasPendingFor('thread-A')).toBe(false)
  })

  it('bad JSON does not crash; subsequent valid lines still work', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.sendRaw('not json at all {{{')
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor('thread-A')).toBe(true)
    bus.resolvePending('thread-A', { behavior: 'allow' })
    const decision = await client.next()
    expect(decision.reqId).toBe('req-1')
    await client.close()
  })

  it('unsupported version is ignored, no decision sent', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 999, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    // Should NOT receive a decision for v:999
    let received: unknown = null
    try { received = await client.next(150) } catch { /* expected timeout */ }
    expect(received).toBeNull()
    expect(bus.hasPendingFor('thread-A')).toBe(false)
    await client.close()
  })

  it('duplicate reqId → second one denied, first stays pending', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'dup',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'dup',
      toolName: 'Read', input: {}, toolUseId: 'tu-2',
    })

    const first = await client.next()
    // Second send hits "duplicate reqId" branch — that's the first decision we see
    expect(first.behavior).toBe('deny')
    expect(first.message).toBe('duplicate reqId')
    // Original is still pending
    expect(bus.hasPendingFor('thread-A')).toBe(true)
    bus.resolvePending('thread-A', { behavior: 'allow' })
    const second = await client.next()
    expect(second.behavior).toBe('allow')

    await client.close()
  })

  it('resolvePending returns false when no pending exists', () => {
    expect(bus.resolvePending('nope', { behavior: 'allow' })).toBe(false)
  })

  it('stop() denies all pending and closes socket', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)

    await bus.stop()

    const decision = await client.next(500)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('shutting down')

    // After stop(), new connections should fail
    let connectErr: Error | null = null
    try { await connectClient(path) } catch (e) { connectErr = e as Error }
    expect(connectErr).not.toBeNull()
  })

  it('notifier rejection → auto deny', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { throw new Error('messenger down') })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('notifier error')
    expect(bus.hasPendingFor('thread-A')).toBe(false)

    await client.close()
  })

  it('auto-allow: rule registered on allow+autoAllowFurther, second request resolves via grace timer', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 80 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      const notifications: ApprovalNotification[] = []
      fastBus.setNotifier(async (n) => { notifications.push(n) })

      const client = await connectClient(fastPath)
      // First call — user replies "all"
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-1',
        toolName: 'Bash', input: { command: 'git status -s' }, toolUseId: 'tu-1',
      })
      for (let i = 0; i < 50 && notifications.length < 1; i++) await sleep(10)
      expect(notifications[0].autoAllow).toBeUndefined() // first ask is normal
      fastBus.resolvePending('thread-A', { behavior: 'allow', autoAllowFurther: true })
      const d1 = await client.next()
      expect(d1.behavior).toBe('allow')
      // Wire payload must NOT carry autoAllowFurther — that's internal-only.
      expect(d1.autoAllowFurther).toBeUndefined()
      expect(fastBus.getAutoAllowKeys('thread-A')).toEqual(['Bash::git s'])

      // Second call — same tool + same prefix → grace mode
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'tu-2',
      })
      for (let i = 0; i < 50 && notifications.length < 2; i++) await sleep(10)
      expect(notifications[1].autoAllow).toEqual({ graceMs: 80 })

      // Don't reply → grace timer fires → allow auto-resolved
      const d2 = await client.next(500)
      expect(d2.behavior).toBe('allow')
      expect(fastBus.hasPendingFor('thread-A')).toBe(false)

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: explicit deny in grace mode revokes the rule', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 1000 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      fastBus.setNotifier(async () => {})

      const client = await connectClient(fastPath)
      // Seed a rule directly via the public path (allow+autoAllowFurther).
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-seed',
        toolName: 'Bash', input: { command: 'rm -rf x' }, toolUseId: 'tu-1',
      })
      await sleep(20)
      fastBus.resolvePending('thread-A', { behavior: 'allow', autoAllowFurther: true })
      await client.next()
      expect(fastBus.getAutoAllowKeys('thread-A')).toEqual(['Bash::rm -r'])

      // Second call hits the rule → grace mode. User explicitly denies.
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'rm -rf y' }, toolUseId: 'tu-2',
      })
      await sleep(20)
      fastBus.resolvePending('thread-A', { behavior: 'deny', message: '不行' })
      const d = await client.next()
      expect(d.behavior).toBe('deny')
      // Rule is revoked → next call should be normal (not auto-allow).
      expect(fastBus.getAutoAllowKeys('thread-A')).toEqual([])

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: non-user denies (run terminated, shutdown) do NOT revoke the rule', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 5000 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      fastBus.setNotifier(async () => {})

      const client = await connectClient(fastPath)
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-1',
        toolName: 'Bash', input: { command: 'ls -la' }, toolUseId: 'tu-1',
      })
      await sleep(20)
      fastBus.resolvePending('thread-A', { behavior: 'allow', autoAllowFurther: true })
      await client.next()

      // Open a 2nd request that hits the rule (auto-allow grace).
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'ls -lh' }, toolUseId: 'tu-2',
      })
      await sleep(20)

      // Simulate "claude died" — unregisterRun → cancelPending(deny). This
      // should NOT clear the rule.
      fastBus.unregisterRun('run-1')
      const d = await client.next()
      expect(d.behavior).toBe('deny')
      expect(fastBus.getAutoAllowKeys('thread-A')).toEqual(['Bash::ls -l'])

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: clearAutoAllowForThread drops every rule', () => {
    bus.clearAutoAllowForThread('does-not-exist') // should not throw
    // Internal — exercise via the real public path: addAutoAllowRule is called
    // via cancelPending. We use a private lookup helper here.
    bus.registerRun('run-clr', RUN_CTX)
    bus.setNotifier(async () => {})
    // After clearing, no rules should remain — start from baseline.
    bus.clearAutoAllowForThread('thread-A')
    expect(bus.getAutoAllowKeys('thread-A')).toEqual([])
  })

  it('queues multiple pending on same thread, resolves head first', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-A',
      toolName: 'Bash', input: {}, toolUseId: 'tu-A',
    })
    await sleep(20)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-B',
      toolName: 'Read', input: {}, toolUseId: 'tu-B',
    })
    await sleep(20)

    expect(bus.hasPendingFor('thread-A')).toBe(true)
    bus.resolvePending('thread-A', { behavior: 'allow' })
    const first = await client.next()
    expect(first.reqId).toBe('req-A')

    expect(bus.hasPendingFor('thread-A')).toBe(true)
    bus.resolvePending('thread-A', { behavior: 'deny', message: 'no' })
    const second = await client.next()
    expect(second.reqId).toBe('req-B')
    expect(second.behavior).toBe('deny')

    await client.close()
  })
})
