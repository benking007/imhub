// MCP sidecar — Claude Code 通过 --permission-prompt-tool 调用本进程的 `request` 工具，
// 本进程把请求转发给 im-hub 主进程的 approval-bus（unix socket），等用户决策回包后
// 翻译成 MCP tool result。
//
// 这是个独立进程，由 claude 子进程通过 --mcp-config 启动；与 im-hub 通信只走 socket。
// 启动需要两个 env：
//   IMHUB_APPROVAL_SOCK  unix socket 路径
//   IMHUB_RUN_ID         本次 claude run 的 ID（与 approvalBus.registerRun 配套）
//
// 协议见 src/core/approval-bus.ts。
//
// 入口（编译后）：node dist/plugins/agents/claude-code/mcp-approval-server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createConnection, type Socket } from 'net'
import { randomUUID } from 'crypto'

const SERVER_NAME = 'imhub'
const TOOL_NAME = 'request'

interface DecisionAllow { behavior: 'allow'; updatedInput?: Record<string, unknown> }
interface DecisionDeny { behavior: 'deny'; message?: string }
type Decision = DecisionAllow | DecisionDeny

interface PendingRequest {
  resolve: (d: Decision) => void
  /** Original tool input — needed to echo back as updatedInput on allow,
   *  since Claude Code rejects an allow response that lacks updatedInput. */
  originalInput: Record<string, unknown>
}

class ApprovalClient {
  private socket: Socket | null = null
  private buf = ''
  private pending = new Map<string, PendingRequest>()
  private connectErr: Error | null = null
  private closed = false
  private connectPromise: Promise<void>

  constructor(private readonly socketPath: string, private readonly runId: string) {
    this.connectPromise = this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const sock = createConnection(this.socketPath)
      sock.setEncoding('utf8')

      const onConnectError = (err: Error): void => {
        this.connectErr = err
        this.closed = true
        // stderr surfaces inside Claude Code's MCP log
        process.stderr.write(`[mcp-approval-server] connect failed: ${err.message}\n`)
        resolve()
      }
      sock.once('error', onConnectError)
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError)
        sock.on('error', (err) => {
          process.stderr.write(`[mcp-approval-server] socket error: ${err.message}\n`)
        })
        sock.on('data', (chunk: string) => this.onData(chunk))
        sock.on('close', () => this.onClose())
        this.socket = sock
        resolve()
      })
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try { msg = JSON.parse(line) } catch {
        process.stderr.write(`[mcp-approval-server] bad json from bus: ${line.slice(0, 200)}\n`)
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (m.v !== 1 || m.type !== 'decision') return
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    if (!reqId) return
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    if (m.behavior === 'allow') {
      const updatedInput = (m.updatedInput && typeof m.updatedInput === 'object' && !Array.isArray(m.updatedInput))
        ? m.updatedInput as Record<string, unknown>
        : p.originalInput   // Claude Code requires updatedInput; echo original
      p.resolve({ behavior: 'allow', updatedInput })
    } else {
      const message = typeof m.message === 'string' ? m.message : undefined
      p.resolve({ behavior: 'deny', ...(message ? { message } : {}) })
    }
  }

  private onClose(): void {
    this.closed = true
    // Drain pending with deny — claude is left hanging otherwise
    for (const [, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'approval bus disconnected' })
    }
    this.pending.clear()
  }

  // request(): see below — request → register pending → write payload

  /**
   * Send an approval request and wait for the decision. If the bus is
   * unreachable or the connection has dropped, returns a deny synchronously.
   */
  async request(args: {
    toolName: string
    input: Record<string, unknown>
    toolUseId: string
  }): Promise<Decision> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { behavior: 'deny', message: `approval bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const payload = JSON.stringify({
      v: 1,
      type: 'approval',
      runId: this.runId,
      reqId,
      toolName: args.toolName,
      input: args.input,
      toolUseId: args.toolUseId,
    }) + '\n'

    return new Promise<Decision>((resolve) => {
      this.pending.set(reqId, { resolve, originalInput: args.input })
      this.socket!.write(payload, (err) => {
        if (err) {
          this.pending.delete(reqId)
          resolve({ behavior: 'deny', message: `write failed: ${err.message}` })
        }
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.socket && !this.socket.destroyed) {
      await new Promise<void>((resolve) => {
        this.socket!.once('close', () => resolve())
        this.socket!.end()
        setTimeout(() => { if (this.socket && !this.socket.destroyed) this.socket.destroy() }, 200).unref()
      })
    }
  }
}

/**
 * Build the MCP server. Exposed as a function (rather than top-level `await`)
 * so tests can construct it without spinning up stdio.
 */
export function buildServer(client: ApprovalClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '0.1.0',
  })

  // Accept both snake_case (what Claude Code sends over the wire) and
  // camelCase (defensive — some forks normalize). passthrough so unknown
  // future fields are not stripped before we see them.
  const inputSchema = {
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: 'IM hub permission prompt',
      description:
        'Routes Claude Code permission prompts to im-hub for human approval over IM. ' +
        'Returns {behavior: "allow"|"deny", ...} as a JSON-encoded text block.',
      inputSchema,
    },
    async (args) => {
      const toolName = args.tool_name ?? args.toolName ?? '<unknown>'
      const input = (args.input ?? {}) as Record<string, unknown>
      const toolUseId = args.tool_use_id ?? args.toolUseId ?? ''

      const decision = await client.request({ toolName, input, toolUseId })
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(decision) },
        ],
      }
    },
  )

  return server
}

export { ApprovalClient }

async function main(): Promise<void> {
  const sockPath = process.env.IMHUB_APPROVAL_SOCK
  const runId = process.env.IMHUB_RUN_ID
  if (!sockPath || !runId) {
    process.stderr.write('[mcp-approval-server] missing IMHUB_APPROVAL_SOCK or IMHUB_RUN_ID\n')
    process.exit(1)
  }

  const client = new ApprovalClient(sockPath, runId)
  const server = buildServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // When stdio closes (claude went away), shut down cleanly.
  const shutdown = async (): Promise<void> => {
    try { await client.close() } catch { /* ignore */ }
    try { await server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Detect "run as script" — when imported by tests we don't want to spin up stdio.
const isMainModule = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    const url = new URL(import.meta.url)
    return url.pathname.endsWith(process.argv[1].replace(/^.*?(?=\/|$)/, '')) ||
      url.pathname === process.argv[1] ||
      process.argv[1].endsWith('mcp-approval-server.js')
  } catch { return false }
})()

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`[mcp-approval-server] fatal: ${err}\n`)
    process.exit(1)
  })
}
