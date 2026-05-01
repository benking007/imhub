// approval-router — 把 approval-bus 的两个端口接到 IM messenger 上：
//   1. notifier：bus 收到 sidecar 的审批请求 → 这里翻译成文本/卡片 → 推到对应 IM thread
//   2. 拦截层：用户在该 thread 回复 y/n/批准/拒绝时，cli 主 handler 把消息先交给我们；
//      命中就 resolvePending，吃掉这条消息不进 router；不命中放行，并把已挂起的
//      pending 当作"用户改主意"自动 deny。
//
// 不知道 messenger 实现细节，只通过注入的 resolveMessenger 拿到 sendMessage/sendCard。

import type { MessengerAdapter } from './types.js'
import { approvalBus, type ApprovalNotification, type Decision } from './approval-bus.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'approval-router' })

const MAX_INPUT_PREVIEW = 400

const ALLOW_TOKENS = new Set([
  'y', 'yes', 'ok', '1', '批准', '同意', '通过', '可以', '✅',
])
const DENY_TOKENS = new Set([
  'n', 'no', '0', '拒绝', '不同意', '不行', '不可以', '不', '❌',
])

/**
 * Classify an inbound IM reply as an approval decision. Returns null when the
 * reply doesn't match any known pattern — the caller should treat that as
 * "user changed topic" and route normally.
 */
export function parseApprovalReply(text: string): Decision | null {
  const trimmed = text.trim().toLowerCase()
  if (!trimmed) return null
  // Strip leading slashes so "/y" works too — some users do that on Telegram.
  const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  if (ALLOW_TOKENS.has(stripped)) {
    return { behavior: 'allow' }
  }
  if (DENY_TOKENS.has(stripped)) {
    return { behavior: 'deny', message: '用户在 IM 中拒绝了这次工具调用' }
  }
  return null
}

/**
 * Render an approval request as a plain text message. We keep this format
 * stable across IM platforms; richer flows (Feishu cards with buttons) can
 * layer on later by checking platform/sendCard.
 */
export function formatApprovalPrompt(n: ApprovalNotification): string {
  const inputJson = safeStringify(n.input, MAX_INPUT_PREVIEW)
  return [
    '🔐 工具调用审批请求',
    `工具：${n.toolName}`,
    `入参：${inputJson}`,
    `回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）`,
    `req: ${n.reqId.slice(0, 8)}`,
  ].join('\n')
}

function safeStringify(v: unknown, maxLen: number): string {
  let s: string
  try { s = JSON.stringify(v) } catch { s = String(v) }
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

/**
 * Map an IM platform name to its messenger registration. WeChat is special-
 * cased because the messenger is registered as "wechat-ilink" but messages
 * carry platform="wechat".
 */
export function platformToMessengerName(platform: string): string {
  return platform === 'wechat' ? 'wechat-ilink' : platform
}

export interface InstallOptions {
  resolveMessenger: (platform: string) => MessengerAdapter | undefined
}

let installed: InstallOptions | null = null

/**
 * Wire approval-bus.notifier to the messenger layer. Idempotent: calling
 * install() twice replaces the previous wiring.
 */
export function install(opts: InstallOptions): void {
  installed = opts
  approvalBus.setNotifier(async (n: ApprovalNotification) => {
    const m = opts.resolveMessenger(n.ctx.platform)
    if (!m) {
      log.warn({ event: 'approval.router.no_messenger', platform: n.ctx.platform, reqId: n.reqId },
        'No messenger registered for platform; approval cannot be surfaced')
      // Throwing tells the bus to auto-deny this request.
      throw new Error(`no messenger for platform ${n.ctx.platform}`)
    }
    const text = formatApprovalPrompt(n)
    await m.sendMessage(n.ctx.threadId, text)
    log.info({ event: 'approval.router.prompt_sent', platform: n.ctx.platform, threadId: n.ctx.threadId, reqId: n.reqId })
  })
}

export function uninstall(): void {
  installed = null
  approvalBus.setNotifier(null)
}

/**
 * Called by cli's onMessage handler before it routes to the agent.
 * Returns true when this message was an approval reply (so the caller should
 * stop and not invoke the normal router).
 *
 * Behavior:
 *   - If thread has no pending approval → return false, do nothing
 *   - If thread has pending AND text parses as decision → resolve, return true
 *   - If thread has pending AND text does NOT parse → auto-deny pending
 *     (user is moving on), return false so the message routes normally
 */
export function tryHandleApprovalReply(threadId: string, text: string): boolean {
  if (!approvalBus.hasPendingFor(threadId)) return false
  const decision = parseApprovalReply(text)
  if (decision) {
    approvalBus.resolvePending(threadId, decision)
    log.info({ event: 'approval.router.resolved', threadId, behavior: decision.behavior })
    return true
  }
  // Unrecognized reply while a pending exists → treat as redirect: deny so
  // the sidecar (and ultimately Claude) doesn't keep waiting, but let the
  // user's actual message route normally.
  approvalBus.resolvePending(threadId, {
    behavior: 'deny',
    message: '用户在 IM 中改换话题，未给出审批回复',
  })
  log.info({ event: 'approval.router.redirected', threadId })
  return false
}

/** Test helper — not exported from index. */
export function _isInstalled(): boolean { return installed !== null }
