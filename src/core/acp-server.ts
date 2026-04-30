// ACP Server — expose im-hub as an ACP-compatible Agent
//
// Endpoints (per ACP convention):
//   GET  /agent/card   → Agent Manifest
//   POST /tasks         → Create task (sync or stream via SSE)
//   GET  /tasks/{id}    → Get task status
//
// Runs on a separate port (default 9090). Reuses web token for auth.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseMessage, routeMessage, type RouteContext } from './router.js'
import { generateTraceId, createLogger, logger as rootLogger } from './logger.js'
import { registry } from './registry.js'
import { createJob, getJob, runJob } from './job-board.js'

const DEFAULT_ACP_PORT = 9090
const WEB_TOKEN_DIR = join(homedir(), '.im-hub')
const WEB_TOKEN_FILE = join(WEB_TOKEN_DIR, 'web-token')
/** Max POST body size (per ACP request). Larger requests get 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024  // 1 MiB

function getToken(): string | null {
  try { return readFileSync(WEB_TOKEN_FILE, 'utf-8').trim() } catch { return null }
}

/** Constant-time string compare. Returns false if lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function parseAuth(req: IncomingMessage): { ok: boolean; error?: string } {
  const token = getToken()
  if (!token) return { ok: false, error: 'Server not configured' }
  const auth = String(req.headers['authorization'] || '')
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return { ok: true }

  // Also accept X-IM-Hub-Token header
  const xToken = String(req.headers['x-im-hub-token'] || '')
  if (xToken && safeEqual(xToken, token)) return { ok: true }

  return { ok: false, error: 'Unauthorized' }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Read POST body with a hard cap. When the limit is exceeded we write a
 * 413 response, drain (and discard) the remainder of the request, and
 * reject — letting the caller `return` early. We do NOT destroy the
 * socket because that races with the response flush.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      total += c.length
      if (total > MAX_BODY_BYTES) {
        aborted = true
        if (!res.headersSent) {
          sendJson(res, 413, { error: 'Request body too large' })
        }
        const err = new Error('Request body too large') as Error & { statusCode?: number; handled?: boolean }
        err.statusCode = 413
        err.handled = true
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

/**
 * Map of task id → (job id, last cached status) for quick GET /tasks/:id
 * lookups. The actual durable record lives in the Job Board.
 */
const taskIndex = new Map<string, { jobId: number }>()

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
        const body = await readBody(req, res)
        const parsedBody = JSON.parse(body) as { input?: { prompt?: string }; mode?: string }
        const input = parsedBody.input
        const mode = parsedBody.mode
        if (!input?.prompt) {
          sendJson(res, 400, { error: 'Missing input.prompt' })
          return
        }

        const taskId = randomBytes(8).toString('hex')
        // Inherit upstream trace id when present so distributed tracing
        // links across the boundary.
        const incomingTrace = String(req.headers['x-trace-id'] || '').trim()
        const traceId = incomingTrace || generateTraceId()
        const logger = createLogger({ traceId, platform: 'acp-server', component: 'acp', taskId })

        // Persist in Job Board so the task survives restarts and shares the
        // /job toolset with messenger-originated jobs.
        const jobId = createJob('acp:gateway', input.prompt)
        taskIndex.set(taskId, { jobId })

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
            'X-Task-Id': taskId,
          })

          let fullText = ''
          try {
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
            // Run + complete via Job Board so the same job row carries the
            // result. We push the completed text through a synthetic runner
            // that yields it once, lets job-board flip status to completed.
            await runJob(jobId, async function* () { yield fullText }, logger)
          } finally {
            res.end()
          }
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
        await runJob(jobId, async function* () { yield fullResponse }, logger)
        sendJson(res, 200, {
          id: taskId,
          status: 'completed',
          output: { content: fullResponse },
        })
      } catch (err) {
        const e = err as Error & { statusCode?: number; handled?: boolean }
        if (e?.handled) return  // 413 already sent by readBody
        const status = e?.statusCode || 500
        const msg = e instanceof Error ? e.message : String(err)
        if (!res.headersSent) sendJson(res, status, { error: msg })
      }
      return
    }

    // GET /tasks/:id
    const taskMatch = url.pathname.match(/^\/tasks\/([a-z0-9]+)$/)
    if (req.method === 'GET' && taskMatch) {
      const idx = taskIndex.get(taskMatch[1])
      if (!idx) { sendJson(res, 404, { error: 'Task not found' }); return }
      const job = getJob(idx.jobId)
      if (!job) { sendJson(res, 404, { error: 'Task record not found' }); return }
      sendJson(res, 200, {
        id: taskMatch[1],
        status: job.status,
        output: job.result ? { content: job.result } : undefined,
        error: job.error || undefined,
      })
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
