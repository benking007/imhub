// /approval command — list / clear in-session auto-allow rules.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Socket, createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { approvalBus, type RunContext } from '../approval-bus.js'
import { handleApprovalCommand } from './approval.js'
import type { RouteContext } from '../router.js'
import type { Logger } from 'pino'

const RUN_CTX: RunContext = { threadId: 'thread-X', platform: 'feishu', userId: 'u', channelId: 'c' }

function makeRouteCtx(): RouteContext {
  return {
    channelId: 'c', threadId: 'thread-X', platform: 'feishu',
    defaultAgent: 'claude-code', traceId: 't',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) } as unknown as Logger,
  }
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-approval-cmd-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function seedRule(socketPath: string, runId: string, reqId: string, toolName: string, command: string): Promise<Socket> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(socketPath)
    s.once('error', reject)
    s.once('connect', () => resolve(s))
  })
  sock.setEncoding('utf8')
  sock.on('data', () => { /* drain decisions */ })
  sock.write(JSON.stringify({
    v: 1, type: 'approval', runId, reqId, toolName,
    input: { command }, toolUseId: 'tu-' + reqId,
  }) + '\n')
  await sleep(20)
  approvalBus.resolvePending('thread-X', { behavior: 'allow', autoAllowFurther: true })
  return sock
}

describe('handleApprovalCommand', () => {
  let path: string

  beforeEach(async () => {
    path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-X', RUN_CTX)
    approvalBus.setNotifier(async () => { /* no-op */ })
  })

  afterEach(async () => {
    approvalBus.clearAutoAllowForThread('thread-X')
    await approvalBus.stop()
  })

  it('reports an empty list when no rules exist', async () => {
    const out = await handleApprovalCommand('', makeRouteCtx())
    expect(out).toContain('没有自动放行规则')
    expect(out).toContain('all')
  })

  it('lists active rules with tool + prefix', async () => {
    const sock1 = await seedRule(path, 'run-X', 'r1', 'Bash', 'git status -s')
    const sock2 = await seedRule(path, 'run-X', 'r2', 'Bash', 'rm -rf /tmp/x')
    expect(approvalBus.getAutoAllowKeys('thread-X').sort()).toEqual([
      'Bash::git s', 'Bash::rm -r',
    ])

    const out = await handleApprovalCommand('', makeRouteCtx())
    expect(out).toContain('本会话自动放行规则 (2)')
    expect(out).toContain('Bash')
    expect(out).toContain('git s')
    expect(out).toContain('rm -r')

    sock1.end(); sock2.end()
  })

  it('clear on an empty thread reports "no rules to clear"', async () => {
    const out = await handleApprovalCommand('clear', makeRouteCtx())
    expect(out).toContain('当前没有自动放行规则')
  })

  it('clear drops every rule for this thread', async () => {
    const sock = await seedRule(path, 'run-X', 'rc', 'Bash', 'docker ps')
    expect(approvalBus.getAutoAllowKeys('thread-X').length).toBe(1)

    const out = await handleApprovalCommand('clear', makeRouteCtx())
    expect(out).toContain('已清空本会话的 1 条自动放行规则')
    expect(approvalBus.getAutoAllowKeys('thread-X')).toEqual([])

    sock.end()
  })
})
