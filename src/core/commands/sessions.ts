// /sessions — list recent opencode sessions from a separate dashboard
//
// Talks to an external (non-im-hub) "dashboard" service that maintains
// the opencode session catalog. The URL is configurable via the
// IM_HUB_DASHBOARD_URL env var so deployments without the dashboard get
// a clear "not configured" message instead of a confusing connection
// refused.

import http from 'http'
import https from 'https'
import { URL } from 'url'
import type { RouteContext } from '../router.js'

const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:8001'
const REQUEST_TIMEOUT_MS = 5_000

interface DashboardSession {
  title?: string
  created?: string
  msgCount?: number
  ageHours?: number
}

interface DashboardResponse {
  sessions?: DashboardSession[]
}

function dashboardUrl(): string {
  return process.env.IM_HUB_DASHBOARD_URL || DEFAULT_DASHBOARD_URL
}

function fetchJson(url: string): Promise<DashboardResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        try { req.destroy(new Error('timeout')) } catch { /* ignore */ }
        reject(new Error('timeout'))
      })
    }, REQUEST_TIMEOUT_MS)

    const req = lib.get(url, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => finish(() => {
        try { resolve(JSON.parse(body)) }
        catch { reject(new Error('invalid JSON')) }
      }))
      res.on('error', (err) => finish(() => reject(err)))
    })
    req.on('error', (err) => finish(() => reject(err)))
  })
}

export async function handleSessionsCommand(_args: string, _ctx: RouteContext): Promise<string> {
  const base = dashboardUrl().replace(/\/+$/, '')
  const url = `${base}/api/sessions/list?limit=10`
  let data: DashboardResponse
  try {
    data = await fetchJson(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      return `⚠️ 无法连接 dashboard (${base})。\n\n确认 dashboard 服务已启动，或设置 \`IM_HUB_DASHBOARD_URL\` 环境变量指向正确的地址。`
    }
    if (msg === 'timeout') {
      return `⚠️ Dashboard 响应超时 (${REQUEST_TIMEOUT_MS}ms): ${base}`
    }
    if (msg === 'invalid JSON') {
      return `⚠️ Dashboard 返回了非 JSON 响应：${base}`
    }
    return `⚠️ Dashboard 调用失败: ${msg}`
  }

  if (!data.sessions?.length) return '📋 暂无活跃会话。'

  let msg = '📋 最近 10 个会话:\n\n'
  data.sessions.forEach((s, i) => {
    const time = s.created
      ? new Date(s.created).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '?'
    const age = typeof s.ageHours === 'number'
      ? (s.ageHours < 1 ? '<1h' : s.ageHours < 24 ? Math.round(s.ageHours) + 'h' : Math.round(s.ageHours / 24) + 'd')
      : '?'
    msg += `${i + 1}. ${s.title || '(无标题)'}\n   ${time} · ${s.msgCount || 0}条 · ${age}前\n`
  })
  msg += '\n当前微信对话的 opencode 会话 6h 内有效，无需手动加载。'
  return msg
}
