// /sessions — list recent sessions from dashboard

import http from 'http'
import type { RouteContext } from '../router.js'

export async function handleSessionsCommand(_args: string, _ctx: RouteContext): Promise<string> {
  try {
    const data = await new Promise<any>((resolve, reject) => {
      http.get('http://127.0.0.1:8001/api/sessions/list?limit=10', (res) => {
        let body = ''
        res.on('data', c => body += c)
        res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
      }).on('error', reject)
    })

    if (!data.sessions?.length) return '📋 暂无活跃会话。'

    let msg = '📋 最近 10 个会话:\n\n'
    data.sessions.forEach((s: any, i: number) => {
      const time = new Date(s.created).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      const ageH = s.ageHours < 1 ? '<1h' : s.ageHours < 24 ? Math.round(s.ageHours) + 'h' : Math.round(s.ageHours / 24) + 'd'
      msg += `${i + 1}. ${s.title}\n   ${time} · ${s.msgCount}条 · ${ageH}前\n`
    })
    msg += '\n当前微信对话的 opencode 会话 6h 内有效，无需手动加载。'
    return msg
  } catch {
    return '⚠️ 无法查询会话列表（dashboard 服务可能未启动）。'
  }
}
