// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { generateTraceId, createLogger, logger as rootLogger } from '../core/logger.js'
import { validateConfig } from '../core/config-schema.js'

const webLog = rootLogger.child({ component: 'web' })
import {
  isAgentAvailableCached,
  loadConfig,
  saveConfig,
  type Config,
} from '../core/onboarding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const DEFAULT_PORT = 3000
const WEB_TOKEN_DIR = join(homedir(), '.im-hub')
const WEB_TOKEN_FILE = join(WEB_TOKEN_DIR, 'web-token')

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function getOrCreateWebToken(): string {
  try {
    return readFileSync(WEB_TOKEN_FILE, 'utf-8').trim()
  } catch {
    const token = generateToken()
    mkdirSync(WEB_TOKEN_DIR, { recursive: true })
    writeFileSync(WEB_TOKEN_FILE, token, { mode: 0o600 })
    return token
  }
}

function isMasked(value: string | undefined): boolean {
  if (!value) return false
  return /^.{0,2}\*{2,}.{0,2}$/.test(value)
}

interface ClientConnection {
  ws: WebSocket
  id: string
  agent: string
}

/**
 * Start the web chat server
 */
export async function startWebServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_PORT
  const webToken = getOrCreateWebToken()
  const clients = new Map<string, ClientConnection>()

  // HTTP request handler — static files + REST API
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // Static pages
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveIndexHtml(res, join(PUBLIC_DIR, 'index.html'), webToken)
    }
    if (url.pathname === '/settings' || url.pathname === '/settings.html') {
      return serveIndexHtml(res, join(PUBLIC_DIR, 'settings.html'), webToken)
    }

    // REST API — require auth token
    if (url.pathname.startsWith('/api/')) {
      const token = req.headers['x-im-hub-token'] as string || ''
      if (token !== webToken) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    // REST API
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return handleGetConfig(req, res)
    }
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      return handlePutConfig(req, res)
    }
    if (url.pathname === '/api/agents/status' && req.method === 'GET') {
      return handleAgentsStatus(req, res)
    }
    if (url.pathname === '/api/agents/acp/test' && req.method === 'POST') {
      return handleAcpTest(req, res)
    }
    if (url.pathname === '/api/agents/acp/discover' && req.method === 'POST') {
      return handleAcpDiscover(req, res)
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return handleListWorkspaces(req, res)
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      return handleMetrics(req, res, url)
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(req, res)
    }
    if (url.pathname === '/api/notify' && req.method === 'POST') {
      return handleNotify(req, res)
    }
    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      return handleInvoke(req, res, options.defaultAgent)
    }

    res.writeHead(404)
    res.end('Not found')
  })

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Verify token from URL query before accepting connection
    const wsUrl = new URL(req.url || '/', `http://localhost:${port}`)
    const wsToken = wsUrl.searchParams.get('token')
    if (wsToken !== webToken) {
      ws.close(1008, 'Unauthorized')
      return
    }

    const clientId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const client: ClientConnection = { ws, id: clientId, agent: options.defaultAgent }
    clients.set(clientId, client)

    webLog.info({ clientId }, 'Client connected')

    // Send available agents list
    sendToClient(ws, {
      type: 'init',
      agents: registry.listAgents(),
      defaultAgent: options.defaultAgent,
      clientId,
    })

    // Load existing session history if available
    sendSessionHistory(ws, clientId, options.defaultAgent)

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        await handleClientMessage(client, msg, options.defaultAgent)
      } catch (err) {
        webLog.error({ clientId, err: err instanceof Error ? err.message : String(err) }, 'Error parsing client message')
        sendToClient(ws, { type: 'error', message: 'Invalid message format' })
      }
    })

    ws.on('close', () => {
      webLog.info({ clientId }, 'Client disconnected')
      clients.delete(clientId)
    })

    ws.on('error', (err) => {
      webLog.error({ clientId, err: err instanceof Error ? err.message : String(err) }, 'Client WebSocket error')
      clients.delete(clientId)
    })
  })

  // Start listening (loopback only by default)
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, '127.0.0.1', () => resolve())
  })

  webLog.info({ port }, `Chat UI available at http://localhost:${port}`)

  return {
    port,
    close: () => {
      // Close all WebSocket connections
      for (const [id, client] of clients) {
        client.ws.close()
        clients.delete(id)
      }
      wss.close()
      httpServer.close()
    },
  }
}

// ============================================
// REST API handlers
// ============================================

async function handleGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const config = await loadConfig()
    const agentStatus = await getAgentStatuses()

    sendJson(res, 200, {
      messengers: config.messengers,
      agents: config.agents,
      defaultAgent: config.defaultAgent,
      telegram: config.telegram
        ? { botToken: mask(config.telegram.botToken), channelId: config.telegram.channelId }
        : undefined,
      feishu: config.feishu
        ? { appId: config.feishu.appId, appSecret: mask(config.feishu.appSecret) }
        : undefined,
      acpAgents: config.acpAgents?.map(a => ({
        ...a,
        auth: a.auth
          ? { ...a.auth, token: a.auth.token ? mask(a.auth.token) : undefined }
          : undefined,
      })),
      webPort: config.webPort,
      agentStatus,
    })
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to load config' })
  }
}

async function handlePutConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const incoming = JSON.parse(body) as Record<string, unknown>
    const existing = await loadConfig()

    const merged: Record<string, unknown> = { ...existing }

    for (const key of Object.keys(incoming)) {
      const val = incoming[key]

      // Deep-protect nested known-masked paths so `ab****yz` never overwrites true value
      if (key === 'telegram' && typeof val === 'object' && val !== null) {
        const t = val as Record<string, unknown>
        merged.telegram = {
          ...(existing.telegram || {}),
          ...t,
          botToken: typeof t.botToken === 'string' && isMasked(t.botToken) ? existing.telegram?.botToken : t.botToken,
        }
        continue
      }
      if (key === 'feishu' && typeof val === 'object' && val !== null) {
        const f = val as Record<string, unknown>
        merged.feishu = {
          ...(existing.feishu || {}),
          ...f,
          appSecret: typeof f.appSecret === 'string' && isMasked(f.appSecret) ? existing.feishu?.appSecret : f.appSecret,
        }
        continue
      }
      if (key === 'acpAgents' && Array.isArray(val)) {
        merged.acpAgents = (val as unknown[]).map((item: unknown, i: number) => {
          const a = item as Record<string, unknown> | undefined
          const old = existing.acpAgents?.[i]
          if (a?.auth && typeof a.auth === 'object' && typeof (a.auth as Record<string, unknown>).token === 'string' && isMasked((a.auth as Record<string, unknown>).token as string)) {
            return { ...a, auth: { ...(a.auth as Record<string, unknown>), token: old?.auth?.token } }
          }
          return a
        })
        continue
      }

      if (typeof val === 'string' && isMasked(val)) {
        continue
      }
      merged[key] = val
    }

    const result = validateConfig(merged)
    if (!result.ok) {
      sendJson(res, 400, { error: 'Config validation failed', details: result.errors })
      return
    }

    await saveConfig(result.config as unknown as Config)
    sendJson(res, 200, { ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 400, { error: msg })
  }
}

async function handleAgentsStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const agentStatus = await getAgentStatuses()
    sendJson(res, 200, agentStatus)
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to check agents' })
  }
}

async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    sendJson(res, 200, { workspaces: workspaceRegistry.list() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

async function handleMetrics(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const fmt = url.searchParams.get('format') || 'prom'
    const { snapshot, toPrometheus } = await import('../core/metrics.js')
    if (fmt === 'json') {
      sendJson(res, 200, snapshot())
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(toPrometheus())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

/**
 * POST /api/notify  → push a message to an IM thread.
 *
 * Body: { platform, threadId, text, card? }
 * Use case: external systems (CI / monitoring / cron) pushing notices
 * back to a chat thread without going through the Agent layer.
 */
async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { platform, threadId, text, card } = JSON.parse(body) as {
      platform?: string; threadId?: string; text?: string; card?: unknown
    }
    if (!platform || !threadId || (!text && !card)) {
      sendJson(res, 400, { error: 'Missing platform / threadId / (text|card)' })
      return
    }

    // Map platform name to messenger plugin name.
    const messengerName = platform === 'wechat' ? 'wechat-ilink' : platform
    const messenger = registry.getMessenger(messengerName)
    if (!messenger) {
      sendJson(res, 404, { error: `Messenger "${platform}" not registered` })
      return
    }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform, component: 'notify' })
    log.info({ threadId, hasCard: !!card, textLen: text?.length || 0 }, 'notify in')

    if (card && typeof messenger.sendCard === 'function') {
      await messenger.sendCard(threadId, card)
    } else if (text) {
      await messenger.sendMessage(threadId, text)
    } else {
      sendJson(res, 400, { error: 'card requires sendCard support, otherwise text is required' })
      return
    }

    sendJson(res, 200, { ok: true, traceId })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

/**
 * POST /api/invoke  → run an agent prompt as if it came from a user.
 *
 * Body: { prompt, agent?, userId?, platform? }
 * Returns a JSON response with the full text (for streaming use the ACP
 * server's POST /tasks?mode=stream instead).
 */
async function handleInvoke(req: IncomingMessage, res: ServerResponse, defaultAgent: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body) as {
      prompt?: string; agent?: string; userId?: string; platform?: string
    }
    if (!parsed.prompt) {
      sendJson(res, 400, { error: 'Missing prompt' })
      return
    }
    const agentName = parsed.agent || defaultAgent
    const promptText = parsed.agent ? `/${parsed.agent} ${parsed.prompt}` : parsed.prompt

    const traceId = generateTraceId()
    const platform = parsed.platform || 'rest'
    const log = createLogger({ traceId, platform, component: 'invoke' })
    log.info({ agent: agentName, promptLen: parsed.prompt.length }, 'invoke in')

    const routeCtx = {
      threadId: `rest:${traceId}`,
      channelId: 'rest',
      platform,
      defaultAgent: agentName,
      traceId,
      logger: log,
      userId: parsed.userId || 'rest-caller',
    }

    const parsedMsg = parseMessage(promptText)
    const result = await routeMessage(parsedMsg, routeCtx)
    let fullText = ''
    if (typeof result === 'string') {
      fullText = result
    } else {
      for await (const chunk of result) fullText += chunk
    }
    sendJson(res, 200, { ok: true, traceId, output: { content: fullText } })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Quick check: agent availability snapshot. Already used by settings UI;
  // exposing it under /api/health gives ops a stable URL.
  try {
    const status = await getAgentStatuses()
    const anyHealthy = Object.values(status).some(Boolean)
    sendJson(res, anyHealthy ? 200 : 503, {
      ok: anyHealthy,
      agents: status,
      uptimeSec: Math.round(process.uptime()),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { ok: false, error: msg })
  }
}

async function handleAcpDiscover(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { baseUrl, register } = JSON.parse(body) as { baseUrl?: string; register?: boolean }
    if (!baseUrl) {
      sendJson(res, 400, { error: 'Missing baseUrl' })
      return
    }
    const { discoverAgents } = await import('../plugins/agents/acp/discovery.js')
    const result = await discoverAgents(baseUrl)
    if (register) {
      await registry.loadACPAgents(result.agents)
    }
    sendJson(res, 200, { ok: true, baseUrl: result.baseUrl, agents: result.agents })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { ok: false, error: msg })
  }
}

async function handleAcpTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { endpoint, auth } = JSON.parse(body)

    // Dynamic import to avoid circular deps
    const { ACPClient } = await import('../plugins/agents/acp/acp-client.js')
    const client = new ACPClient({ name: 'test', endpoint, auth })
    const manifest = await client.fetchManifest()

    sendJson(res, 200, {
      ok: true,
      name: manifest.name,
      description: manifest.description,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 400, { ok: false, error: msg })
  }
}

// ============================================
// Helpers
// ============================================

async function getAgentStatuses(): Promise<Record<string, boolean>> {
  const agents = registry.listAgents()
  const status: Record<string, boolean> = {}
  await Promise.all(
    agents.map(async (name) => {
      const agent = registry.findAgent(name)
      if (agent) {
        try {
          status[name] = await agent.isAvailable()
        } catch {
          status[name] = false
        }
      }
    })
  )
  return status
}

function mask(value: string | undefined): string {
  if (!value) return ''
  if (value.length <= 4) return '****'
  return value.slice(0, 2) + '****' + value.slice(-2)
}

/** Hard cap on inbound JSON bodies for the Web REST API. */
const MAX_API_BODY_BYTES = 1 * 1024 * 1024  // 1 MiB

function readBody(req: IncomingMessage, res?: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > MAX_API_BODY_BYTES) {
        aborted = true
        if (res && !res.headersSent) {
          sendJson(res, 413, { error: 'Request body too large' })
        }
        const err = new Error('Request body too large') as Error & { statusCode?: number; handled?: boolean }
        err.statusCode = 413
        err.handled = !!res
        reject(err)
        return
      }
      chunks.push(chunk)
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ============================================
// WebSocket chat handlers
// ============================================

/**
 * Handle a message from a web client
 */
async function handleClientMessage(
  client: ClientConnection,
  msg: { type: string; text?: string; agent?: string },
  defaultAgent: string
): Promise<void> {
  const { ws, id: clientId } = client

  switch (msg.type) {
    case 'message': {
      if (!msg.text?.trim()) return

      const text = msg.text.trim()
      const traceId = generateTraceId()
      const logger = createLogger({ traceId, platform: 'web', component: 'web' })

      if (msg.agent && msg.agent !== client.agent) {
        client.agent = msg.agent
      }

      const parsed = parseMessage(text)

      try {
        const routeCtx: RouteContext = {
          threadId: clientId,
          channelId: 'web',
          platform: 'web',
          defaultAgent: client.agent,
          traceId,
          logger,
          userId: `web:${clientId}`,
        }

        logger.info({ event: 'message.received', text: text.substring(0, 120) })

        const result = await routeMessage(parsed, routeCtx)

        // String response (built-in commands, errors)
        if (typeof result === 'string') {
          sendToClient(ws, { type: 'done', text: result })
          return
        }

        // Streaming response (agent responses)
        let fullText = ''
        for await (const chunk of result) {
          fullText += chunk
          sendToClient(ws, { type: 'chunk', text: chunk })
        }
        sendToClient(ws, { type: 'done', text: fullText })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        logger.error({ event: 'web.handle.error', err: errorMsg, stack }, 'Error handling client message')
        sendToClient(ws, { type: 'error', message: `Agent error: ${errorMsg}` })
      }
      break
    }

    case 'switch-agent': {
      if (!msg.agent) return
      const agent = registry.findAgent(msg.agent)
      if (!agent) {
        sendToClient(ws, { type: 'error', message: `Agent "${msg.agent}" not found` })
        return
      }
      if (!(await isAgentAvailableCached(agent.name))) {
        sendToClient(ws, { type: 'error', message: `Agent "${agent.name}" is not available` })
        return
      }
      client.agent = agent.name
      await sessionManager.switchAgent('web', 'web', clientId, agent.name)
      sendToClient(ws, { type: 'agent-switched', agent: agent.name })
      break
    }

    case 'get-agents': {
      const agents = registry.listAgents()
      sendToClient(ws, { type: 'agents', agents })
      break
    }

    case 'get-history': {
      await sendSessionHistory(ws, clientId, defaultAgent)
      break
    }
  }
}

/**
 * Send session history to a client
 */
async function sendSessionHistory(ws: WebSocket, clientId: string, defaultAgent: string): Promise<void> {
  const history = await sessionManager.getSessionWithHistory('web', 'web', clientId)
  if (history && history.messages.length > 0) {
    sendToClient(ws, {
      type: 'history',
      messages: history.messages,
      agent: history.session.agent,
    })
  }
}

/**
 * Send a JSON message to a WebSocket client
 */
function sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/**
 * Serve a static file (no token injection needed)
 */
function serveStatic(res: ServerResponse, filePath: string, contentType: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
}

/**
 * Serve index/settings HTML with injected web token for API auth
 */
function serveIndexHtml(res: ServerResponse, filePath: string, token: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  let html = readFileSync(filePath, 'utf-8')
  html = html.replace('</head>', `<script>window.IMHUB_TOKEN='${token}';</script></head>`)
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(html)
}
