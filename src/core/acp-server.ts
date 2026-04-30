// ACP Server — expose im-hub as an ACP-compatible Agent
//
// Endpoints (per ACP convention):
//   GET  /agent/card   → Agent Manifest
//   POST /tasks         → Create task (sync or stream via SSE)
//   GET  /tasks/{id}    → Get task status
//
// Runs on a separate port (default 9090). Reuses web token for auth.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseMessage, routeMessage, type RouteContext } from './router.js'
import { generateTraceId, createLogger, logger as rootLogger } from './logger.js'
import { registry } from './registry.js'

const DEFAULT_ACP_PORT = 9090
const WEB_TOKEN_DIR = join(homedir(), '.im-hub')
const WEB_TOKEN_FILE = join(WEB_TOKEN_DIR, 'web-token')

function getToken(): string | null {
  try { return readFileSync(WEB_TOKEN_FILE, 'utf-8').trim() } catch { return null }
}

function parseAuth(req: IncomingMessage): { ok: boolean; error?: string } {
  const token = getToken()
  if (!token) return { ok: false, error: 'Server not configured' }
  const auth = req.headers['authorization'] || ''
  if (auth === `Bearer ${token}`) return { ok: true }

  // Also accept X-IM-Hub-Token header
  const xToken = req.headers['x-im-hub-token'] as string || ''
  if (xToken === token) return { ok: true }

  return { ok: false, error: 'Unauthorized' }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => resolve(body))
  })
}

// In-memory task store (minimal, to be replaced by Job Board in Phase 3.3)
const taskStore = new Map<string, { status: string; result?: string; error?: string }>()

export async function startACPServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_ACP_PORT
  const agents = registry.listAgents()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // CORS for browser-based ACP clients
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-IM-Hub-Token')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const auth = parseAuth(req)
    if (!auth.ok) { sendJson(res, 401, { error: auth.error }); return }

    // GET /agent/card
    if (req.method === 'GET' && url.pathname === '/agent/card') {
      sendJson(res, 200, {
        name: 'im-hub-gateway',
        description: 'IM Hub — Intelligent multi-agent gateway',
        version: '0.3.0',
        protocols: ['acp/v1'],
        capabilities: {
          streaming: true,
          agents: agents.map(a => ({ name: a, id: a })),
        },
        auth: { type: 'bearer' },
      })
      return
    }

    // POST /tasks
    if (req.method === 'POST' && url.pathname === '/tasks') {
      try {
        const body = await readBody(req)
        const { input, mode } = JSON.parse(body)
        if (!input?.prompt) {
          sendJson(res, 400, { error: 'Missing input.prompt' })
          return
        }

        const taskId = randomBytes(8).toString('hex')
        const traceId = generateTraceId()
        const logger = createLogger({ traceId, platform: 'acp-server', component: 'acp' })

        taskStore.set(taskId, { status: 'running' })

        const routeCtx: RouteContext = {
          threadId: `acp:${taskId}`,
          channelId: 'acp',
          platform: 'acp',
          defaultAgent: options.defaultAgent,
          traceId,
          logger,
          userId: 'acp-caller',
        }

        const parsed = parseMessage(input.prompt)
        const result = await routeMessage(parsed, routeCtx)

        if (mode === 'stream') {
          // SSE streaming response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })

          let fullText = ''
          if (typeof result === 'string') {
            res.write(`data: ${JSON.stringify({ output: { content: result } })}\n\n`)
            fullText = result
          } else {
            for await (const chunk of result) {
              fullText += chunk
              res.write(`data: ${JSON.stringify({ output: { content: chunk } })}\n\n`)
            }
          }
          res.write('data: [DONE]\n\n')
          taskStore.set(taskId, { status: 'completed', result: fullText })
          res.end()
          return
        }

        // Sync mode
        let fullResponse = ''
        if (typeof result === 'string') {
          fullResponse = result
        } else {
          for await (const chunk of result) {
            fullResponse += chunk
          }
        }
        taskStore.set(taskId, { status: 'completed', result: fullResponse })
        sendJson(res, 200, {
          id: taskId,
          status: 'completed',
          output: { content: fullResponse },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, 500, { error: msg })
      }
      return
    }

    // GET /tasks/:id
    const taskMatch = url.pathname.match(/^\/tasks\/([a-z0-9]+)$/)
    if (req.method === 'GET' && taskMatch) {
      const task = taskStore.get(taskMatch[1])
      if (!task) { sendJson(res, 404, { error: 'Task not found' }); return }
      sendJson(res, 200, { id: taskMatch[1], status: task.status, output: task.result ? { content: task.result } : undefined, error: task.error })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  rootLogger.info({ component: 'acp', port }, `ACP Server listening on http://127.0.0.1:${port}`)

  return {
    port,
    close: () => { server.close() },
  }
}
