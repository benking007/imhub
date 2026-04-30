// /model [name|#N] + /models [filter|refresh] — model switching & listing
//
// Currently only the opencode adapter ships variants/models that the
// router can switch between, so this command is opencode-scoped. When
// the active agent isn't opencode we surface a friendly "not supported"
// message instead of querying the wrong CLI.

import { spawn } from 'child_process'
import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

const SUPPORTED_AGENT = 'opencode'
const MODEL_LIST_TTL_MS = 5 * 60 * 1000  // 5 minutes — picks up newly-added models

function sessionKey(ctx: RouteContext): string {
  // Mirrors SessionManager's key shape so the cached numbered list lives
  // alongside the actual session state (no userId mismatch in groups).
  return `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
}

function parseModelArgs(args: string): { sub: string; rest: string } {
  const p = args.trim().split(/\s+/)
  return { sub: p[0] || '', rest: p.slice(1).join(' ') }
}

/** Per-session cache: last /models ordered result, indexed from 1 */
const sessionModelIndex = new Map<string, string[]>()

export async function handleModelCommand(args: string, ctx: RouteContext): Promise<string> {
  const { sub, rest } = parseModelArgs(args)

  // /model refresh — force re-query the underlying CLI (M-5)
  if (sub === 'refresh') {
    invalidateModelCache()
    return '✅ 模型缓存已清空。下次 /models 将重新查询。'
  }

  // Determine which agent the active session is using; fall back to default
  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  const activeAgent = session?.agent || ctx.defaultAgent
  if (activeAgent !== SUPPORTED_AGENT) {
    return `ℹ️ \`/model\` 仅在 \`${SUPPORTED_AGENT}\` 下可用，当前 agent: \`${activeAgent}\`。\n\n切换到 opencode：/oc 或 /opencode`
  }

  // /models or /models <filter> — list all models
  if (sub === 'list') {
    return handleModelList(rest, ctx)
  }

  // /model (no args) — show current model
  if (args.trim() === '') {
    return handleModelCurrent(ctx)
  }

  // /model <name|#N> — switch model (by full name, short name, or index)
  return handleModelSwitch(args.trim(), ctx)
}

/** /models — list available models with optional filter, numbered */
async function handleModelList(filter: string, ctx: RouteContext): Promise<string> {
  const models = await getModelList()
  const defaultModel = await resolveDefaultModel()
  const lowered = filter.toLowerCase()
  const filtered = lowered ? models.filter(m => m.toLowerCase().includes(lowered)) : models

  if (filtered.length === 0) {
    if (filter) return `🔍 没有匹配 "${filter}" 的模型。`
    return `⚠️ 未能获取模型列表。请确认 opencode 已安装且配置了模型。`
  }

  const session = await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  const current = session?.model || defaultModel

  // Build a flat indexed list for /model #N lookup
  let idx = 1
  const flat: { num: number; full: string }[] = []
  const groups = new Map<string, { num: number; short: string; full: string }[]>()
  for (const m of filtered) {
    const parts = m.split('/')
    const prov = parts.length >= 2 ? parts.slice(0, -1).join('/') : m
    const short = m.split('/').pop()!
    if (!groups.has(prov)) groups.set(prov, [])
    groups.get(prov)!.push({ num: idx, short, full: m })
    flat.push({ num: idx, full: m })
    idx++
  }

  // Cache indexed list keyed identically to SessionManager.
  sessionModelIndex.set(sessionKey(ctx), flat.map(f => f.full))

  let msg = `📋 模型列表 (${filtered.length})\n\n`

  for (const [prov, list] of groups) {
    msg += `**${prov}**\n`
    for (const { num, short, full } of list) {
      const tag = full === current ? ' ⭐' : ''
      msg += `  ${String(num).padStart(3, ' ')}. \`${short}\`${tag}\n`
    }
  }
  msg += `\n当前: \`${current}\` ⭐\n/model <全名> 或 /model #序号 切换\n/models refresh 强制刷新缓存`
  return msg
}

/** /model — show currently selected model */
async function handleModelCurrent(ctx: RouteContext): Promise<string> {
  const session = await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  const defaultModel = await resolveDefaultModel()
  const current = session?.model || defaultModel
  return `🧠 当前模型: \`${current}\`\n\n使用 /model <全名> 或 /model #序号 切换\n使用 /models 查看所有模型`
}

/** /model <name|#N> — switch to a different model */
async function handleModelSwitch(input: string, ctx: RouteContext): Promise<string> {
  // Check if input is an index reference #N or just N
  const indexMatch = input.match(/^#?(\d+)$/)
  if (indexMatch) {
    const num = parseInt(indexMatch[1], 10)
    const cached = sessionModelIndex.get(sessionKey(ctx))
    if (!cached || cached.length === 0) {
      return `⚠️ 没有缓存的模型列表。请先 /models 查看，再用 /model #序号 切换。`
    }
    if (num < 1 || num > cached.length) {
      return `⚠️ 序号 ${num} 无效。可用范围: 1 - ${cached.length}\n\n先 /models 查看完整列表。`
    }
    const model = cached[num - 1]
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { model })
    return `✅ 模型已切换: \`${model}\``
  }

  // Check if input is a short name (no /) but looks like a model name
  if (!input.includes('/')) {
    return `⚠️ 模型格式: provider/model\n例: /model deepseek/deepseek-v4-pro\n或: /model #5 (序号切换)\n\n先 /models 查看`
  }

  const models = await getModelList()
  const exactMatch = models.find(m => m === input || m.endsWith('/' + input))
  if (!exactMatch && models.length > 0) {
    return `⚠️ 模型 "${input}" 不在列表中。\n\n先 /models 查看可用模型。`
  }

  const resolved = exactMatch || input
  await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { model: resolved })
  return `✅ 模型已切换: \`${resolved}\``
}

interface ListCache<T> { value: T; ts: number }
let modelListCache: ListCache<string[]> | null = null
let defaultModelCache: ListCache<string> | null = null

function invalidateModelCache(): void {
  modelListCache = null
  defaultModelCache = null
}

function getModelList(): Promise<string[]> {
  return new Promise((resolve) => {
    if (modelListCache && Date.now() - modelListCache.ts < MODEL_LIST_TTL_MS) {
      return resolve(modelListCache.value)
    }
    const proc = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout!.on('data', d => out += d.toString())
    proc.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean)
      modelListCache = { value: lines, ts: Date.now() }
      resolve(lines)
    })
    proc.on('error', () => resolve([]))
  })
}

/** Resolve opencode's actual default model name */
async function resolveDefaultModel(): Promise<string> {
  if (defaultModelCache && Date.now() - defaultModelCache.ts < MODEL_LIST_TTL_MS) {
    return defaultModelCache.value
  }

  // Read opencode.json to find the first configured model as the default
  try {
    const { readFile } = await import('fs/promises')
    const { homedir } = await import('os')
    const { join } = await import('path')
    const configPath = join(homedir(), '.config', 'opencode', 'opencode.json')
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    const provider = config.provider as Record<string, { models?: Record<string, unknown> }> | undefined
    if (provider) {
      for (const [, p] of Object.entries(provider)) {
        if (p.models && typeof p.models === 'object') {
          const keys = Object.keys(p.models)
          if (keys.length > 0) {
            defaultModelCache = { value: keys[0], ts: Date.now() }
            return keys[0]
          }
        }
      }
    }
  } catch { /* fall through */ }

  const models = await getModelList()
  if (models.length > 0) {
    defaultModelCache = { value: models[0], ts: Date.now() }
    return models[0]
  }
  return 'unknown'
}

/** Test-only diagnostic: clear caches between cases. */
export const _internal = { invalidateModelCache }
