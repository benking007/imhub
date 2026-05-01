// approval-bus — IM 端人工审批的进程内总线
//
// 角色：在 im-hub 主进程里跑一个 unix socket 服务，等 claude 子进程的
// MCP "approval sidecar" 通过 socket 连进来发审批请求。bus 自己不决策，
// 只做三件事：
//   1. 把请求转给 notifier（由 messenger 层注入：负责推 IM 卡片）
//   2. 维护 pending 队列，按 threadId 索引，等 resolvePending 回流决策
//   3. 超时 / 进程退出 / 连接断开 时自动 deny，保证 sidecar 端不会卡死
//
// 协议：unix socket + NDJSON，每行一个 JSON 对象。
//   sidecar → bus:  {v:1, type:"approval", runId, reqId, toolName, input, toolUseId}
//   bus → sidecar:  {v:1, type:"decision", reqId, behavior:"allow"|"deny", ...}
//
// 单实例 export approvalBus；测试可 new ApprovalBus({approvalTimeoutMs}) 调小超时。

import { createServer, type Server, type Socket } from 'net'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'approval-bus' })

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LINE_BYTES = 256 * 1024
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 4

export interface RunContext {
  threadId: string
  platform: string
  userId: string
  channelId: string
}

export type Decision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

export interface ApprovalNotification {
  runId: string
  reqId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  ctx: RunContext
}

/** Notifier 只负责"通知 IM 推卡片/消息"。不要在这里返回决策；决策走 resolvePending。 */
export type ApprovalNotifier = (n: ApprovalNotification) => Promise<void>

interface PendingApproval {
  runId: string
  reqId: string
  toolName: string
  threadId: string
  socket: Socket
  timer: ReturnType<typeof setTimeout>
  resolved: boolean
}

export interface ApprovalBusOptions {
  approvalTimeoutMs?: number
}

export class ApprovalBus {
  private server: Server | null = null
  private socketPath: string | null = null
  private readonly approvalTimeoutMs: number

  private runContexts = new Map<string, RunContext>()
  private pendingById = new Map<string, PendingApproval>()
  private pendingByThread = new Map<string, PendingApproval[]>()
  private connections = new Set<Socket>()
  private notifier: ApprovalNotifier | null = null

  constructor(opts: ApprovalBusOptions = {}) {
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  }

  /** 注入"通知 IM 推送"的回调。messenger 层启动时调一次。 */
  setNotifier(n: ApprovalNotifier | null): void {
    this.notifier = n
  }

  /** 启动 unix socket 服务。返回最终使用的 socket 路径。 */
  async start(socketPath?: string): Promise<string> {
    if (this.server) throw new Error('approval-bus already started')
    const path = socketPath ?? defaultSocketPath()
    try { await unlink(path) } catch { /* stale socket cleanup */ }

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      const onErr = (err: Error): void => { reject(err) }
      server.once('error', onErr)
      server.listen(path, () => {
        server.removeListener('error', onErr)
        this.server = server
        this.socketPath = path
        log.info({ event: 'approval.bus.started', path })
        resolve(path)
      })
    })
  }

  async stop(): Promise<void> {
    // Reject everything still pending
    for (const p of [...this.pendingById.values()]) {
      this.cancelPending(p, { behavior: 'deny', message: 'approval-bus shutting down' })
    }
    this.runContexts.clear()
    this.pendingById.clear()
    this.pendingByThread.clear()

    // server.close() doesn't terminate existing connections. Half-close each
    // (so the deny payload buffered above gets flushed) and fall back to
    // destroy() after a short grace window if the peer doesn't disconnect.
    const conns = [...this.connections]
    this.connections.clear()
    await Promise.all(conns.map((s) => new Promise<void>((resolve) => {
      if (s.destroyed) { resolve(); return }
      s.once('close', () => resolve())
      try { s.end() } catch { /* ignore */ }
      setTimeout(() => { if (!s.destroyed) s.destroy() }, 200).unref()
    })))

    const srv = this.server
    if (!srv) return
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    this.server = null
    if (this.socketPath) {
      try { await unlink(this.socketPath) } catch { /* ignore */ }
      this.socketPath = null
    }
  }

  registerRun(runId: string, ctx: RunContext): void {
    this.runContexts.set(runId, ctx)
  }

  /** 进程结束时调。pending 全 deny，runContext 清掉。 */
  unregisterRun(runId: string): void {
    this.runContexts.delete(runId)
    for (const p of [...this.pendingById.values()]) {
      if (p.runId === runId) {
        this.cancelPending(p, { behavior: 'deny', message: 'run terminated' })
      }
    }
  }

  hasPendingFor(threadId: string): boolean {
    return (this.pendingByThread.get(threadId)?.length ?? 0) > 0
  }

  /**
   * 由 messenger.onMessage 拦截层调用。把 thread 队列头部的 pending 用
   * 给定决策 resolve 掉。返回是否真的 resolve 到了一个 pending。
   */
  resolvePending(threadId: string, decision: Decision): boolean {
    const q = this.pendingByThread.get(threadId)
    const head = q?.[0]
    if (!head) return false
    this.cancelPending(head, decision)
    return true
  }

  /** 测试用：当前 socket 路径。 */
  getSocketPath(): string | null { return this.socketPath }

  // --- internals ---

  private handleConnection(socket: Socket): void {
    this.connections.add(socket)
    let buf = ''
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_BUFFER_BYTES) {
        log.warn({ event: 'approval.bus.buffer_overflow', bytes: buf.length })
        socket.destroy()
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.length === 0) continue
        if (line.length > MAX_LINE_BYTES) {
          log.warn({ event: 'approval.bus.line_too_long', len: line.length })
          continue
        }
        this.handleLine(line, socket).catch((err) => {
          log.error({ event: 'approval.bus.handle_error', err: String(err) })
        })
      }
    })

    socket.on('error', (err) => {
      log.warn({ event: 'approval.bus.socket_error', err: String(err) })
    })

    socket.on('close', () => {
      this.connections.delete(socket)
      // sidecar 掉线：相关 pending 全 deny（claude 那边大概率也已经死了，写不写都无所谓）
      for (const p of [...this.pendingById.values()]) {
        if (p.socket === socket) {
          this.cancelPending(p, { behavior: 'deny', message: 'sidecar disconnected' })
        }
      }
    })
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      log.warn({ event: 'approval.bus.bad_json', line: line.slice(0, 200) })
      return
    }
    if (!msg || typeof msg !== 'object') {
      log.warn({ event: 'approval.bus.bad_msg' })
      return
    }
    const m = msg as Record<string, unknown>
    if (m.v !== 1) {
      log.warn({ event: 'approval.bus.unsupported_version', v: m.v })
      return
    }
    if (m.type === 'approval') {
      await this.handleApproval(m, socket)
      return
    }
    log.warn({ event: 'approval.bus.unknown_type', type: m.type })
  }

  private async handleApproval(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const runId = typeof m.runId === 'string' ? m.runId : null
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const toolName = typeof m.toolName === 'string' ? m.toolName : null
    const toolUseId = typeof m.toolUseId === 'string' ? m.toolUseId : ''
    const input = (m.input && typeof m.input === 'object' && !Array.isArray(m.input))
      ? m.input as Record<string, unknown>
      : {}

    if (!reqId) {
      log.warn({ event: 'approval.bus.missing_reqId' })
      return  // 没 reqId 没法回包，丢弃
    }
    if (!runId || !toolName) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'invalid approval message' })
      return
    }
    const ctx = this.runContexts.get(runId)
    if (!ctx) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: `unknown runId: ${runId}` })
      return
    }
    if (!this.notifier) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'no notifier installed' })
      return
    }
    if (this.pendingById.has(reqId)) {
      // 重复 reqId（sidecar bug）：拒绝新的，老的留着
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'duplicate reqId' })
      return
    }

    const pending: PendingApproval = {
      runId,
      reqId,
      toolName,
      threadId: ctx.threadId,
      socket,
      resolved: false,
      timer: setTimeout(() => {
        this.cancelPending(pending, { behavior: 'deny', message: 'approval timeout' })
      }, this.approvalTimeoutMs),
    }
    this.pendingById.set(reqId, pending)
    const q = this.pendingByThread.get(ctx.threadId) ?? []
    q.push(pending)
    this.pendingByThread.set(ctx.threadId, q)

    log.info({ event: 'approval.bus.request', runId, reqId, toolName, threadId: ctx.threadId })

    try {
      await this.notifier({ runId, reqId, toolName, input, toolUseId, ctx })
    } catch (err) {
      log.error({ event: 'approval.bus.notifier_error', reqId, err: String(err) })
      this.cancelPending(pending, { behavior: 'deny', message: 'notifier error' })
    }
  }

  private cancelPending(p: PendingApproval, decision: Decision): void {
    if (p.resolved) return
    p.resolved = true
    clearTimeout(p.timer)
    this.sendDecision(p.socket, p.reqId, decision)
    this.removePending(p)
  }

  private removePending(p: PendingApproval): void {
    this.pendingById.delete(p.reqId)
    const q = this.pendingByThread.get(p.threadId)
    if (!q) return
    const idx = q.indexOf(p)
    if (idx >= 0) q.splice(idx, 1)
    if (q.length === 0) this.pendingByThread.delete(p.threadId)
  }

  private sendDecision(socket: Socket, reqId: string, decision: Decision): void {
    if (!socket.writable) return
    const payload = JSON.stringify({ v: 1, type: 'decision', reqId, ...decision }) + '\n'
    socket.write(payload, (err) => {
      if (err) log.warn({ event: 'approval.bus.write_failed', reqId, err: String(err) })
    })
  }
}

function defaultSocketPath(): string {
  return join(tmpdir(), `imhub-approval-${process.pid}-${Date.now().toString(36)}.sock`)
}

/** 进程级单例。im-hub 启动时 await approvalBus.start() 一次。 */
export const approvalBus = new ApprovalBus()
