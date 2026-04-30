// /model [name] + /models [filter] — model switching & listing

import { spawn } from 'child_process'
import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

function parseModelArgs(args: string): { sub: string; rest: string } {
  const p = args.trim().split(/\s+/)
  return { sub: p[0] || '', rest: p.slice(1).join(' ') }
}

export async function handleModelCommand(args: string, ctx: RouteContext): Promise<string> {
  const { sub, rest } = parseModelArgs(args)

  // /models — list models
  if (sub === '' || args.trim() === '') {
    // Show current model
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    const current = session?.model || 'default'
    return `🧠 当前模型: \`${current}\`\n\n/models  查看所有模型  /models <关键字>  过滤\n/model <name>  切换`
  }

  if (sub === 's') {
    // /models [filter]
    const filter = rest.toLowerCase()
    const models = await getModelList()
    const filtered = filter ? models.filter(m => m.toLowerCase().includes(filter)) : models

    if (filtered.length === 0) return `🔍 没有匹配 "${filter}" 的模型。`

    let msg = `📋 模型列表 (${filtered.length})\n\n`
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    const current = session?.model || 'default'

    const groups = new Map<string, string[]>()
    for (const m of filtered) {
      const p = m.split('/')
      const prov = p.length >= 3 ? `${p[0]}/${p[1]}` : p[0]
      if (!groups.has(prov)) groups.set(prov, [])
      groups.get(prov)!.push(m)
    }

    for (const [prov, list] of groups) {
      msg += `**${prov}**\n`
      for (const m of list) {
        const short = m.split('/').slice(-1)[0]
        msg += `  \`${short}\`${m === current ? ' ⭐' : ''}\n`
      }
    }
    msg += `\n当前: \`${current}\` ⭐\n/model <full-name> 切换`
    return msg
  }

  // /model <name> — switch
  const model = args.trim()
  if (!model.includes('/')) return `⚠️ 模型格式: provider/model\n例: /model deepseek/deepseek-v4-pro\n\n先 /models 查看`

  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  if (session) { session.model = model }
  return `✅ 模型已切换: \`${model}\``
}

let cachedModels: string[] | null = null

function getModelList(): Promise<string[]> {
  return new Promise((resolve) => {
    if (cachedModels) return resolve(cachedModels)
    const proc = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout!.on('data', d => out += d.toString())
    proc.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean)
      cachedModels = lines
      resolve(lines)
    })
    proc.on('error', () => resolve([]))
  })
}
