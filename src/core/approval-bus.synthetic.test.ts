// ApprovalBus.registerSyntheticPending — P2 bridge surface tests.
//
// The synthetic path exists for transports that aren't unix-socket sidecars
// (opencode HTTP, future MCP-over-HTTP backends). Behavior parity with the
// socket path is the contract: same notifier, same timeout, same auto-allow,
// same resolvePending entry. The only thing that differs is *delivery* —
// caller's `dispatch(decision)` callback replaces socket writes.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ApprovalBus, type ApprovalNotification, type Decision } from './approval-bus.js'

const RUN_CTX = { threadId: 'thread-A', platform: 'feishu', userId: 'u', channelId: 'c' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ApprovalBus.registerSyntheticPending', () => {
  let bus: ApprovalBus

  beforeEach(() => {
    bus = new ApprovalBus({ approvalTimeoutMs: 200, autoAllowGraceMs: 80 })
    // start() listens on a socket path even for synthetic-only use; that's
    // fine — synthetic path doesn't touch the socket. Skip start() so we
    // don't open file handles for tests that don't need it.
  })

  afterEach(async () => {
    await bus.stop().catch(() => {})
  })

  it('happy path: notifier fires, resolve(allow) dispatches once', async () => {
    let notified: ApprovalNotification | null = null
    bus.setNotifier(async (n) => { notified = n })

    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-ses-1',
      reqId: 'perm-1',
      toolName: 'external_directory',
      input: { patterns: ['/root/workspace/im-hub/*'] },
      ctx: RUN_CTX,
      dispatch: (d) => { decisions.push(d) },
    })

    expect(notified).not.toBeNull()
    expect(notified!.toolName).toBe('external_directory')
    expect(notified!.input).toEqual({ patterns: ['/root/workspace/im-hub/*'] })
    expect(notified!.ctx.threadId).toBe('thread-A')
    expect(bus.hasPendingFor('thread-A')).toBe(true)

    bus.resolvePending('thread-A', { behavior: 'allow' })
    expect(decisions.length).toBe(1)
    expect(decisions[0]).toEqual({ behavior: 'allow' })
    expect(bus.hasPendingFor('thread-A')).toBe(false)
  })

  it('resolve(deny) forwards the message via dispatch', async () => {
    bus.setNotifier(async () => {})
    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-1', toolName: 'bash', input: { command: 'rm -rf /' },
      ctx: RUN_CTX, dispatch: (d) => decisions.push(d),
    })

    bus.resolvePending('thread-A', { behavior: 'deny', message: 'hard no' })
    expect(decisions[0]).toEqual({ behavior: 'deny', message: 'hard no' })
  })

  it('timeout in normal mode dispatches deny("approval timeout")', async () => {
    bus.setNotifier(async () => {})
    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-1', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => decisions.push(d),
    })

    await sleep(300)
    expect(decisions.length).toBe(1)
    expect(decisions[0].behavior).toBe('deny')
    if (decisions[0].behavior === 'deny') {
      expect(decisions[0].message).toBe('approval timeout')
    }
    expect(bus.hasPendingFor('thread-A')).toBe(false)
  })

  it('auto-allow grace mode: timer expiry dispatches allow', async () => {
    // Pre-seed the rule by going through the bus's user-allow+all path.
    bus.setNotifier(async () => {})
    const firstDispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-seed', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => firstDispatched.push(d),
    })
    bus.resolvePending('thread-A', { behavior: 'allow', autoAllowFurther: true })
    expect(firstDispatched[0]).toEqual({ behavior: 'allow', autoAllowFurther: true })

    // Now a second call with the same fingerprint enters auto-allow mode.
    const secondDispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-2', toolName: 't',
      input: { command: 'git stash' },  // shares "git s" prefix with the rule
      ctx: RUN_CTX, dispatch: (d) => secondDispatched.push(d),
    })

    // Grace timer expires → bus auto-resolves to allow without user input.
    await sleep(150)
    expect(secondDispatched.length).toBe(1)
    expect(secondDispatched[0].behavior).toBe('allow')
  })

  it('auto-allow user-deny path revokes the rule', async () => {
    bus.setNotifier(async () => {})
    const seeded: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-seed', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => seeded.push(d),
    })
    bus.resolvePending('thread-A', { behavior: 'allow', autoAllowFurther: true })
    expect(bus.getAutoAllowKeys('thread-A').length).toBe(1)

    // Second call enters grace mode, user explicitly denies → revoke.
    const second: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-2', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => second.push(d),
    })
    const info = bus.resolvePending('thread-A', { behavior: 'deny' })
    expect(info?.wasAutoAllow).toBe(true)
    expect(second[0].behavior).toBe('deny')
    expect(bus.getAutoAllowKeys('thread-A').length).toBe(0)
  })

  it('throws when no notifier is installed (caller falls back)', async () => {
    let threw = false
    try {
      await bus.registerSyntheticPending({
        runId: 'oc-1', reqId: 'perm-1', toolName: 't', input: {},
        ctx: RUN_CTX, dispatch: () => {},
      })
    } catch (err) {
      threw = true
      expect(String(err)).toContain('no notifier installed')
    }
    expect(threw).toBe(true)
  })

  it('duplicate reqId is dropped silently — first pending wins', async () => {
    let notifyCount = 0
    bus.setNotifier(async () => { notifyCount++ })

    const first: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-dup', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => first.push(d),
    })

    const second: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-dup', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => second.push(d),
    })

    expect(notifyCount).toBe(1)
    bus.resolvePending('thread-A', { behavior: 'allow' })
    expect(first.length).toBe(1)
    expect(second.length).toBe(0)  // duplicate dispatch never fired
  })

  it('dispatch errors are isolated (bus keeps working)', async () => {
    bus.setNotifier(async () => {})
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-bad', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: () => { throw new Error('boom') },
    })

    // Should NOT throw despite dispatch's rejection.
    bus.resolvePending('thread-A', { behavior: 'allow' })
    expect(bus.hasPendingFor('thread-A')).toBe(false)

    // A subsequent registration in the same thread still works.
    const next: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-next', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => next.push(d),
    })
    bus.resolvePending('thread-A', { behavior: 'allow' })
    expect(next.length).toBe(1)
  })

  it('unregisterRun denies all synthetic pendings tied to that runId', async () => {
    bus.setNotifier(async () => {})
    const dispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-ses-1', reqId: 'p-1', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => dispatched.push(d),
    })

    bus.unregisterRun('oc-ses-1')
    expect(dispatched.length).toBe(1)
    expect(dispatched[0].behavior).toBe('deny')
    if (dispatched[0].behavior === 'deny') {
      expect(dispatched[0].message).toBe('run terminated')
    }
  })
})
