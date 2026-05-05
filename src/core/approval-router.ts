// approval-router — 把 approval-bus 的两个端口接到 IM messenger 上：
//   1. notifier：bus 收到 sidecar 的审批请求 → 这里翻译成文本/卡片 → 推到对应 IM thread
//   2. 拦截层：用户在该 thread 回复 y/n/批准/拒绝时，cli 主 handler 把消息先交给我们；
//      命中就 resolvePending，吃掉这条消息不进 router；不命中放行，并把已挂起的
//      pending 当作"用户改主意"自动 deny。
//
// 不知道 messenger 实现细节，只通过注入的 resolveMessenger 拿到 sendMessage/sendCard。

import type {
  MessengerAdapter,
  ButtonCallback,
  ApprovalCardPrompt,
  ApprovalCardOutcome,
} from './types.js'
import {
  approvalBus,
  type ApprovalNotification,
  type Decision,
  type ResolvedInfo,
  type ResolutionEvent,
} from './approval-bus.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'approval-router' })

/** Truncation limit for the plain-text approval prompt. Conservative because
 *  some IMs (older WeChat clients) start chunking aggressively past ~500
 *  chars and the y/n line at the bottom must stay visible. */
const MAX_INPUT_PREVIEW = 400

/** Truncation limit for the rich-card approval prompt. Telegram allows ~4 KB
 *  per message; with the surrounding template (~150 chars) and a <pre>
 *  block, 1500 fits in one bubble and covers the long tail of Bash / Edit
 *  payloads without losing context. */
const MAX_INPUT_PREVIEW_CARD = 1500

const ALLOW_TOKENS = new Set([
  'y', 'yes', 'ok', '1', '批准', '同意', '通过', '可以', '✅',
])
const DENY_TOKENS = new Set([
  'n', 'no', '0', '拒绝', '不同意', '不行', '不可以', '不', '❌',
])
/** "Approve this and auto-approve future calls of the same tool with the
 *  same input prefix in this session." Bus consumes `autoAllowFurther` and
 *  registers the rule. */
const ALLOW_ALL_TOKENS = new Set([
  'all', 'a', '全部', '总是', '都同意', '都批准',
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
  if (ALLOW_ALL_TOKENS.has(stripped)) {
    return { behavior: 'allow', autoAllowFurther: true }
  }
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
 *
 * Two flavors:
 *   - Normal: "y 批准 / n 拒绝 / all 同意并对该工具同类调用 5s 自动放行"
 *   - Auto-allow grace mode (n.autoAllow set): "⏱ 自动放行中… 5s 内回 n 可拒绝"
 */
export function formatApprovalPrompt(n: ApprovalNotification): string {
  const inputJson = safeStringify(n.input, MAX_INPUT_PREVIEW)
  if (n.autoAllow) {
    const sec = Math.round(n.autoAllow.graceMs / 1000)
    return [
      `⏱ 自动放行中（${sec}s 后执行）`,
      `工具：${n.toolName}`,
      `入参：${inputJson}`,
      `回复 n 可拒绝（同时撤销该工具的自动放行规则）`,
      `req: ${n.reqId.slice(0, 8)}`,
    ].join('\n')
  }
  return [
    '🔐 工具调用审批请求',
    `工具：${n.toolName}`,
    `入参：${inputJson}`,
    `回复 y 批准 / n 拒绝 / all 本会话内同工具同前缀自动放行（5 分钟内未操作将自动拒绝）`,
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
  /** Optional. Platform names whose messengers should have button-callback
   *  support bound at install time. Adapters that don't implement
   *  onButtonCallback are silently skipped. Defaults to all known IM
   *  platforms; existing tests / callers don't need to pass this. */
  buttonCallbackPlatforms?: string[]
}

let installed: InstallOptions | null = null

/** Per-reqId card tracking. Populated when sendApprovalCard succeeds; cleared
 *  when the card is edited to its terminal state (via button click or text
 *  reply that triggers editCardOnThreadResolution). Survives only in memory —
 *  bus restart wipes pendings anyway. */
interface ActiveCard {
  platform: string
  threadId: string
  messageId: string
}
const activeCards = new Map<string, ActiveCard>()

/**
 * Wire approval-bus.notifier to the messenger layer. Idempotent: calling
 * install() twice replaces the previous wiring.
 *
 * Notifier prefers the rich-card path (sendApprovalCard) when the resolved
 * adapter implements it; otherwise it falls back to the plain-text path
 * (sendMessage with formatApprovalPrompt). The text path is the canonical
 * approval channel for adapters without native interactive buttons (Feishu
 * cards aren't wired for buttons yet, WeChat iLink can't render them).
 *
 * Button callbacks: for each platform listed in buttonCallbackPlatforms
 * whose adapter implements onButtonCallback, we subscribe a handler that
 * parses callback_data of the form `apv:<reqId>:<y|n|a>` and resolves the
 * matching pending. Subscribing happens once at install — adapters started
 * later won't receive button wiring until install() is called again.
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

    // Rich-card path (Telegram inline keyboard).
    if (m.sendApprovalCard) {
      const prompt: ApprovalCardPrompt = {
        reqId: n.reqId,
        toolName: n.toolName,
        inputJson: safeStringify(n.input, MAX_INPUT_PREVIEW_CARD),
        mode: n.autoAllow ? 'auto-allow' : 'normal',
        graceSeconds: n.autoAllow ? Math.round(n.autoAllow.graceMs / 1000) : undefined,
      }
      try {
        const { messageId } = await m.sendApprovalCard(n.ctx.threadId, prompt)
        activeCards.set(n.reqId, {
          platform: n.ctx.platform,
          threadId: n.ctx.threadId,
          messageId,
        })
        log.info({
          event: 'approval.router.card_sent',
          platform: n.ctx.platform,
          threadId: n.ctx.threadId,
          reqId: n.reqId,
          messageId,
        })
        return
      } catch (err) {
        log.warn({
          event: 'approval.router.card_failed_fallback',
          err: String(err),
          reqId: n.reqId,
        }, 'sendApprovalCard threw; falling back to text path')
        // Fall through to text path
      }
    }

    // Text path (Feishu / WeChat / any adapter without sendApprovalCard).
    const text = formatApprovalPrompt(n)
    await m.sendMessage(n.ctx.threadId, text)
    log.info({ event: 'approval.router.prompt_sent', platform: n.ctx.platform, threadId: n.ctx.threadId, reqId: n.reqId })
  })

  const platforms = opts.buttonCallbackPlatforms ?? ['telegram', 'feishu', 'wechat']
  for (const platform of platforms) {
    const m = opts.resolveMessenger(platform)
    if (m?.onButtonCallback) {
      m.onButtonCallback(async (cb) => handleButtonCallback(platform, cb))
      log.info({ event: 'approval.router.button_handler_bound', platform })
    }
  }

  // Listen for non-user resolutions (timeout, sidecar disconnect, run
  // terminated, shutdown, notifier error) so we can collapse the card to
  // a terminal "已过期" state. The user-driven path (button click / y-n
  // text reply) edits the card itself BEFORE the listener fires — by that
  // time activeCards has already been pruned, so this listener no-ops on
  // cause='user'. Defensive double-check via cause makes intent explicit.
  approvalBus.setResolutionListener((e) => onBusResolution(e))
}

export function uninstall(): void {
  installed = null
  approvalBus.setNotifier(null)
  approvalBus.setResolutionListener(null)
  activeCards.clear()
  // Note: we don't unsubscribe button handlers from messengers — tests that
  // re-install will overwrite via onButtonCallback's "replace previous"
  // contract. Production never uninstalls.
}

/**
 * Bus-side resolution listener. Fires for every transition pending → resolved
 * regardless of cause. We only act on non-user causes here: those are the
 * cases where no IM-side handler updated the card, so without us the user
 * sees a card with stale buttons.
 *
 * For auto-allow grace expiry that resolves to allow, we still mark the card
 * as 'allowed' (without byUserDisplay) — the call did go through, just
 * silently. For all other non-user causes (timeout deny, disconnect, run
 * terminated, shutdown, notifier error), the card collapses to 'expired'.
 */
function onBusResolution(e: ResolutionEvent): void {
  if (e.cause === 'user') return  // button/text path already edited
  const card = activeCards.get(e.reqId)
  if (!card) return  // text-fallback path doesn't track cards
  activeCards.delete(e.reqId)
  if (!installed) return
  const m = installed.resolveMessenger(card.platform)
  if (!m?.editApprovalCard) return

  let decision: import('./types.js').ApprovalCardOutcome['decision']
  if (e.cause === 'timeout' && e.decision.behavior === 'allow') {
    // auto-allow grace fired silently
    decision = 'allowed'
  } else {
    decision = 'expired'
  }
  m.editApprovalCard(card.threadId, card.messageId, {
    decision,
    atDate: new Date(),
  }).catch((err) => {
    log.warn({ event: 'approval.router.bus_edit_failed', reqId: e.reqId, err: String(err) })
  })
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
 *
 * Receipt: when the resolution adds or revokes an auto-allow rule, also
 * sends a one-line confirmation back to the IM thread so the user knows
 * the rule landed (or got cleared). Best-effort: a missing messenger or
 * sendMessage failure is logged and ignored — the approval itself already
 * resolved successfully.
 */
export function tryHandleApprovalReply(threadId: string, text: string): boolean {
  if (!approvalBus.hasPendingFor(threadId)) return false
  const decision = parseApprovalReply(text)
  if (decision) {
    const info = approvalBus.resolvePending(threadId, decision)
    log.info({ event: 'approval.router.resolved', threadId, behavior: decision.behavior })
    if (info) {
      editCardOnThreadResolution(threadId, info, decision, undefined)
      sendReceiptIfAny(info, decision)
    }
    return true
  }
  // Unrecognized reply while a pending exists → treat as redirect: deny so
  // the sidecar (and ultimately Claude) doesn't keep waiting, but let the
  // user's actual message route normally.
  const redirectDecision: Decision = {
    behavior: 'deny',
    message: '用户在 IM 中改换话题，未给出审批回复',
  }
  const info = approvalBus.resolvePending(threadId, redirectDecision)
  if (info) editCardOnThreadResolution(threadId, info, redirectDecision, undefined)
  log.info({ event: 'approval.router.redirected', threadId })
  return false
}

/**
 * Inline-button handler. callback_data format: `apv:<reqId>:<y|n|a>`.
 * Resolves the matching pending via approvalBus.resolvePending, acks the
 * button (must happen within ~1s on Telegram), edits the card to its
 * terminal state, and sends the same auto-allow receipt the text path
 * would send.
 *
 * Late clicks (already resolved or expired): we ack with a soft hint and
 * try to edit the card to the "expired" state so subsequent users see a
 * clean terminal view.
 */
async function handleButtonCallback(platform: string, cb: ButtonCallback): Promise<void> {
  const parsed = parseCallbackData(cb.data)
  if (!parsed) {
    await cb.ack('未识别的按钮')
    return
  }
  const decision = decisionFromButton(parsed.choice)
  const info = approvalBus.resolvePending(cb.threadId, decision)

  if (!info) {
    await cb.ack('请求已过期或已被处理')
    if (installed) {
      const m = installed.resolveMessenger(platform)
      if (m?.editApprovalCard) {
        await m.editApprovalCard(cb.threadId, cb.messageId, {
          decision: 'expired',
          atDate: new Date(),
        }).catch((err) => {
          log.warn({ event: 'approval.router.expire_edit_failed', err: String(err) })
        })
      }
    }
    activeCards.delete(parsed.reqId)
    return
  }

  const ackText = decision.behavior === 'allow'
    ? (decision.autoAllowFurther ? '🛡 已批准并自动放行' : '✅ 已批准')
    : (info.wasAutoAllow ? '❌ 已拒绝并撤销规则' : '❌ 已拒绝')
  await cb.ack(ackText)

  if (installed) {
    const m = installed.resolveMessenger(info.platform)
    if (m?.editApprovalCard) {
      const outcome: ApprovalCardOutcome = {
        decision: outcomeFromDecision(decision, info.wasAutoAllow),
        byUserDisplay: cb.userDisplay,
        atDate: new Date(),
      }
      await m.editApprovalCard(cb.threadId, cb.messageId, outcome).catch((err) => {
        log.warn({ event: 'approval.router.edit_failed', err: String(err) })
      })
    }
  }
  activeCards.delete(parsed.reqId)

  log.info({
    event: 'approval.router.button_resolved',
    platform,
    threadId: cb.threadId,
    behavior: decision.behavior,
    autoAllowFurther: decision.behavior === 'allow' && decision.autoAllowFurther === true,
  })

  sendReceiptIfAny(info, decision)
}

/** Find the active card belonging to this thread (the one matching the head
 *  of the pending queue we just resolved) and edit it to its terminal state.
 *  Used by the text-reply path so y/n typed messages also collapse the card
 *  on Telegram. No-op when no card was registered (other IMs / fallback). */
function editCardOnThreadResolution(
  threadId: string,
  info: ResolvedInfo,
  decision: Decision,
  byUserDisplay: string | undefined,
): void {
  if (!installed) return
  let target: { reqId: string; card: ActiveCard } | null = null
  for (const [reqId, card] of activeCards) {
    if (card.threadId === threadId) {
      target = { reqId, card }
      break
    }
  }
  if (!target) return
  activeCards.delete(target.reqId)
  const m = installed.resolveMessenger(info.platform)
  if (!m?.editApprovalCard) return
  const outcome: ApprovalCardOutcome = {
    decision: outcomeFromDecision(decision, info.wasAutoAllow),
    byUserDisplay,
    atDate: new Date(),
  }
  m.editApprovalCard(target.card.threadId, target.card.messageId, outcome).catch((err) => {
    log.warn({ event: 'approval.router.edit_failed', err: String(err) })
  })
}

function outcomeFromDecision(d: Decision, wasAutoAllow: boolean): ApprovalCardOutcome['decision'] {
  if (d.behavior === 'allow') {
    return d.autoAllowFurther ? 'allowed-pinned' : 'allowed'
  }
  return wasAutoAllow ? 'denied-revoked' : 'denied'
}

/**
 * Parse callback_data of the form `apv:<reqId>:<y|n|a>`. reqId may itself
 * contain characters but never `:` in practice (UUID / opaque sidecar id);
 * we still split on the LAST colon to be safe, leaving the choice as the
 * single trailing letter.
 */
export function parseCallbackData(data: string): { reqId: string; choice: 'y' | 'n' | 'a' } | null {
  if (!data.startsWith('apv:')) return null
  const rest = data.slice(4)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return null
  const reqId = rest.slice(0, lastColon)
  const choice = rest.slice(lastColon + 1)
  if (choice !== 'y' && choice !== 'n' && choice !== 'a') return null
  if (!reqId) return null
  return { reqId, choice }
}

function decisionFromButton(choice: 'y' | 'n' | 'a'): Decision {
  if (choice === 'y') return { behavior: 'allow' }
  if (choice === 'a') return { behavior: 'allow', autoAllowFurther: true }
  return { behavior: 'deny', message: '用户在 IM 中拒绝了这次工具调用（按钮）' }
}

/**
 * If the user just enabled an auto-allow rule (allow + autoAllowFurther) or
 * just revoked one (deny while in grace mode), push a short confirmation
 * line to the originating thread.
 */
function sendReceiptIfAny(info: ResolvedInfo, decision: Decision): void {
  if (!installed) return
  let msg: string | null = null
  if (decision.behavior === 'allow' && decision.autoAllowFurther) {
    msg = [
      '✅ 已批准并启用自动放行',
      `规则：${info.toolName} 前缀 "${info.fingerprint}" 5s 内自动放行`,
      '撤销：本会话回 n 单条 / /approval clear 清空',
    ].join('\n')
  } else if (decision.behavior === 'deny' && info.wasAutoAllow) {
    msg = `❌ 已拒绝并撤销自动放行规则：${info.toolName} "${info.fingerprint}"`
  }
  if (!msg) return
  const m = installed.resolveMessenger(info.platform)
  if (!m) {
    log.warn({ event: 'approval.router.receipt_no_messenger', platform: info.platform })
    return
  }
  m.sendMessage(info.threadId, msg).catch((err) => {
    log.warn({ event: 'approval.router.receipt_failed', err: String(err) })
  })
}

/** Test helper — not exported from index. */
export function _isInstalled(): boolean { return installed !== null }
