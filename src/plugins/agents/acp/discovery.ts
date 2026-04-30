// ACP agent discovery via the `.well-known/acp` HTTP endpoint.
//
// Convention: a host that wants to publish one or more ACP-compatible
// agents serves a JSON document at <base>/.well-known/acp containing:
//
//   {
//     "agents": [
//       {
//         "name": "weather-bot",
//         "endpoint": "https://example.com/agents/weather",
//         "aliases": ["w", "wx"],
//         "auth": { "type": "bearer", "token": "..." },
//         "description": "Real-time weather forecasts"
//       },
//       ...
//     ]
//   }
//
// The endpoint must be the BASE of the agent's ACP root — discovery
// itself does not poke the agent's `/agent/card`; that's left to
// ACPAdapter.isAvailable() at registration time.

import type { ACPAgentConfig } from './types.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'acp-discovery' })
const DISCOVERY_TIMEOUT_MS = 10_000

export interface DiscoveryResult {
  baseUrl: string
  agents: ACPAgentConfig[]
}

/**
 * Validate one entry from the well-known doc. Returns a clean
 * ACPAgentConfig or null if the entry is malformed.
 */
function validateEntry(raw: unknown): ACPAgentConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name.length === 0) return null
  if (typeof r.endpoint !== 'string' || r.endpoint.length === 0) return null

  const out: ACPAgentConfig = {
    name: r.name,
    endpoint: r.endpoint,
  }
  if (Array.isArray(r.aliases)) {
    out.aliases = r.aliases.filter((a): a is string => typeof a === 'string')
  }
  if (r.auth && typeof r.auth === 'object') {
    const auth = r.auth as Record<string, unknown>
    if (auth.type === 'none' || auth.type === 'apikey' || auth.type === 'bearer') {
      out.auth = {
        type: auth.type,
        token: typeof auth.token === 'string' ? auth.token : undefined,
      }
    }
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  return out
}

/**
 * Fetch and parse `<baseUrl>/.well-known/acp`. Trailing slashes are
 * trimmed. Returns the discovery result on success; throws on network
 * error, non-2xx status, or invalid JSON. Individual malformed agent
 * entries are skipped silently with a warn log.
 */
export async function discoverAgents(baseUrl: string): Promise<DiscoveryResult> {
  const cleaned = baseUrl.replace(/\/+$/, '')
  const url = `${cleaned}/.well-known/acp`
  log.info({ url }, 'Discovering ACP agents')

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Discovery failed: ${res.status} ${res.statusText}`)
  }

  const body = (await res.json()) as { agents?: unknown }
  if (!body || !Array.isArray(body.agents)) {
    throw new Error('Invalid discovery doc: missing `agents` array')
  }

  const agents: ACPAgentConfig[] = []
  for (const raw of body.agents) {
    const entry = validateEntry(raw)
    if (entry) {
      agents.push(entry)
    } else {
      log.warn({ raw }, 'Skipping malformed agent entry')
    }
  }

  log.info({ baseUrl: cleaned, count: agents.length }, 'Discovery complete')
  return { baseUrl: cleaned, agents }
}

/**
 * Discover from multiple base URLs in parallel. Failures on individual
 * URLs are logged but don't fail the batch — partial results are
 * returned. Useful for `discoveryUrls` config or REST API fan-out.
 */
export async function discoverMany(baseUrls: string[]): Promise<DiscoveryResult[]> {
  const results = await Promise.allSettled(baseUrls.map((u) => discoverAgents(u)))
  const out: DiscoveryResult[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.push(r.value)
    } else {
      log.warn({ baseUrl: baseUrls[i], error: String(r.reason) }, 'Discovery failed')
    }
  })
  return out
}
