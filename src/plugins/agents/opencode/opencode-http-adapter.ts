// OpenCode HTTP driver.
//
// Why this exists:
//   `opencode run --format json` (the stdio driver in opencode-stdio-adapter.ts)
//   does NOT emit `permission.asked` events on its stdout stream, and its
//   inline auto-reject logic occasionally fails to release the prompt
//   deferred — the process then hangs until im-hub's 30-min hard SIGTERM.
//   Audit confirmed this on 2026-05-04 (rows id=283/284, exact 1,800,000 ms).
//
// What this driver does instead:
//   1. Lazily starts a long-lived `opencode serve` daemon on 127.0.0.1
//      (via OpencodeServeManager). Probes-and-reuses any healthy daemon
//      already on the configured port so back-to-back im-hub restarts
//      don't bind-fail on a still-running child.
//   2. Subscribes to /event SSE so the adapter — not the run-CLI — owns the
//      authoritative event stream.
//   3. Creates sessions via POST /session and submits prompts via
//      POST /session/:id/message. Resumes existing sessions when
//      opts.agentSessionId is set; on first turn of a resumed session this
//      process lifetime, PATCHes the session ruleset to apply the current
//      gate policy.
//   4. Routes `permission.asked` SSE events through the IM approval bus
//      when an IM context (threadId + platform) and notifier are both
//      available. Decisions translate: allow → opencode `once`, deny →
//      opencode `reject` (with optional message). Without an IM channel
//      the adapter falls back to auto-`once` so non-IM call paths (web,
//      scheduler) keep working.
//   5. Exits cleanly on `session.status: idle` for the right session,
//      surfaces `session.error`, and is bounded by OPENCODE_TIMEOUT_MS
//      (default 30 min).
//
// Selection: env IMHUB_OPENCODE_DRIVER=http picks this; anything else (incl
// unset) picks the stdio adapter. See ./index.ts factory.
//
// Gate policy: env IMHUB_OPENCODE_GATE controls which permissions surface
// as IM cards. See buildSessionRuleset() for the strict / medium / loose /
// none levels — medium is the default and gates edit / write / patch.
//
// Compatibility: extends OpenCodeAdapter so registry / tests that probe
// `instanceof OpenCodeAdapter` stay green. The base class's spawnStream is
// not used — sendPrompt is overridden end-to-end.

import { OpenCodeAdapter } from './opencode-stdio-adapter.js'
import type { AgentSendOpts, ChatMessage } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { OpencodeServeManager, opencodeServe as defaultServe } from './serve-manager.js'
import { approvalBus as defaultApprovalBus, type ApprovalBus, type Decision } from '../../../core/approval-bus.js'

const log = rootLogger.child({ component: 'agent.opencode.http' })

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Shape of an event arriving on opencode's /event SSE stream. Every field
 *  is optional because we are deliberately conservative — opencode's bus is
 *  shared across many event types and we touch only the slice we need. */
interface OpencodePart {
  type?: string
  text?: string
  tokens?: { input?: number; output?: number; total?: number; reasoning?: number }
  cost?: number
  time?: { start?: number; end?: number }
  sessionID?: string
}

interface OpencodeEvent {
  type: string
  properties?: {
    sessionID?: string
    info?: { id?: string; status?: { type?: string }; sessionID?: string }
    part?: OpencodePart
    status?: { type?: string }
    error?: unknown
    /** permission.asked carries an id at properties.id (Permission.Request). */
    id?: string
    /** Permission name on permission.asked, e.g. "external_directory" / "bash". */
    permission?: string
    /** Patterns the agent wants to access. */
    patterns?: string[]
    /** Tool-specific metadata that may help the user decide. */
    metadata?: Record<string, unknown>
  }
}

export interface HttpAdapterOptions {
  /** Override the singleton serve manager. Tests inject a mock. */
  serve?: OpencodeServeManager
  /** Override fetch. Tests inject a mock. */
  fetchImpl?: typeof fetch
  /** Override the IM approval bus. Defaults to the process singleton; pass
   *  `null` to disable the bridge entirely (used by tests that want to lock
   *  in the no-bus fallback path). */
  approvalBus?: ApprovalBus | null
}

export class OpenCodeHttpAdapter extends OpenCodeAdapter {
  private readonly serve: OpencodeServeManager
  private readonly fetchImpl: typeof fetch
  /** null when the bridge is intentionally disabled. */
  private readonly approvalBus: ApprovalBus | null
  /** Set of opencode session ids whose ruleset we've already PATCHed in this
   *  process lifetime. Lets us re-apply the gate policy when an im-hub
   *  restart resurfaces an old session, without duplicating rules every
   *  turn. Cleared only by im-hub restart — that's fine since the rules
   *  the previous run wrote are still in opencode's session DB. */
  private readonly rulesetApplied = new Set<string>()

  constructor(opts: HttpAdapterOptions = {}) {
    super()
    this.serve = opts.serve ?? defaultServe
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.approvalBus = opts.approvalBus === null
      ? null
      : (opts.approvalBus ?? defaultApprovalBus)
    log.info({ event: 'opencode.http.driver_selected', bridge: this.approvalBus !== null },
      '[opencode] HTTP driver active (real serve + SSE; IM approval bridge when bus has notifier)')
  }

  /**
   * Translate a single SSE event into adapter-side effects:
   *   - sessionID capture → opts.onAgentSessionId
   *   - step-finish cost/tokens → opts.onUsage
   *   - text-part with finished `time.end` → returned as a chunk
   * Pure: tests drive this directly without spinning up a daemon.
   */
  inspectHttpEvent(event: OpencodeEvent, sessionID: string, opts: AgentSendOpts): { text?: string } {
    const props = event.properties ?? {}
    const part = props.part

    // sessionID can appear on the event root, on properties, on properties.info
    // or inside part. Bubble up the first one we see — setOpencodeSessionId
    // (the receiver) is idempotent.
    const sid = props.sessionID || part?.sessionID || props.info?.sessionID
    if (sid && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(sid) } catch { /* don't let userland callbacks kill the stream */ }
    }

    if (event.type === 'message.part.updated' && part) {
      if (part.type === 'step-finish') {
        const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
        if (typeof part.cost === 'number' && Number.isFinite(part.cost)) delta.costUsd = part.cost
        if (typeof part.tokens?.input === 'number') delta.tokensInput = part.tokens.input
        if (typeof part.tokens?.output === 'number') delta.tokensOutput = part.tokens.output
        if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
          if (opts.onUsage) {
            try { opts.onUsage(delta) } catch { /* same — user callback safety */ }
          }
        }
      }

      // Match the stdio adapter: only yield text once the part is fully
      // emitted (time.end set). Avoids streaming partial fragments and keeps
      // /stats response_len aligned across drivers.
      const eventSid = props.sessionID || props.info?.sessionID || part.sessionID
      if (
        part.type === 'text' &&
        part.text &&
        part.time?.end &&
        eventSid === sessionID
      ) {
        return { text: part.text }
      }
    }

    return {}
  }

  /**
   * `session.status` event with status.type === 'idle' for our session is
   * the canonical "stop" signal in opencode (cf. run.ts:532).
   */
  isIdleEvent(event: OpencodeEvent, sessionID: string): boolean {
    if (event.type !== 'session.status') return false
    const props = event.properties ?? {}
    const sid = props.sessionID || props.info?.sessionID
    if (sid !== sessionID) return false
    return props.status?.type === 'idle' || props.info?.status?.type === 'idle'
  }

  isErrorEvent(event: OpencodeEvent, sessionID: string): { error: string } | null {
    if (event.type !== 'session.error') return null
    const props = event.properties ?? {}
    if (props.sessionID !== sessionID) return null
    const e = props.error as Record<string, unknown> | undefined
    let msg = 'session error'
    if (e && typeof e === 'object') {
      if (typeof e.name === 'string') msg = e.name
      const data = e.data as Record<string, unknown> | undefined
      if (data && typeof data.message === 'string') msg = data.message
    }
    return { error: msg }
  }

  buildHttpContextualPrompt(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) return prompt
    const historyText = history
      .map(msg => `[${msg.role === 'user' ? 'User' : 'Assistant'}]: ${msg.content}`)
      .join('\n\n')
    return `Previous conversation context:\n${historyText}\n\nCurrent request: ${prompt}`
  }

  override async *sendPrompt(
    _sessionId: string,
    prompt: string,
    history?: ChatMessage[],
    opts?: AgentSendOpts,
  ): AsyncGenerator<string> {
    const callOpts = opts ?? {}
    const baseUrl = await this.serve.ensureRunning()

    let sessionID = callOpts.agentSessionId
    if (!sessionID) {
      sessionID = await this.createSession(baseUrl, callOpts)
      if (callOpts.onAgentSessionId) {
        try { callOpts.onAgentSessionId(sessionID) } catch { /* ignore */ }
      }
      // Newly-created sessions already received the ruleset in createSession's
      // POST body — no need to PATCH again. Mark applied so we skip the dup.
      this.rulesetApplied.add(sessionID)
    } else if (callOpts.planMode) {
      // Plan mode: opencode's `plan` primary agent already ships with its own
      // stricter ruleset (edit denied except .opencode/plans/*.md). Stacking
      // the medium-gate edit/write/patch=ask rules on top would just create
      // redundant ask prompts during read-only planning. Skip the PATCH and
      // let plan agent's defaults govern this turn. We intentionally do NOT
      // mark rulesetApplied — once the user /plan off's and we resume normal
      // turns, the next non-plan turn should re-apply the medium gate.
    } else if (!this.rulesetApplied.has(sessionID)) {
      // Resumed session: opencode loaded its previously-stored ruleset,
      // which may predate the current gate policy (older sessions were
      // created with no override at all). PATCH the gate ruleset onto it
      // so edit/write/patch correctly route through the IM bridge for the
      // rest of this process's lifetime.
      //
      // Claim the slot synchronously so concurrent prompts on the same
      // session don't fire duplicate PATCHes; remove on failure so the
      // next turn retries instead of leaving the session permanently
      // unguarded if this attempt fails transiently.
      const targetSession = sessionID
      this.rulesetApplied.add(targetSession)
      this.applyRuleset(baseUrl, targetSession).catch((err: unknown) => {
        this.rulesetApplied.delete(targetSession)
        log.warn({ event: 'opencode.http.apply_ruleset_failed', err: String(err), sessionID: targetSession })
      })
    }

    log.info(
      { event: 'opencode.http.send', sessionID, historyLen: history?.length || 0, hasResume: !!callOpts.agentSessionResume },
      'sendPrompt',
    )

    // When resuming, opencode already has the conversation in its DB — feeding
    // history again would duplicate every prior turn. (Same invariant as the
    // stdio driver — see router.callAgentWithHistory zeroing effectiveHistory.)
    const contextualPrompt = callOpts.agentSessionResume
      ? prompt
      : this.buildHttpContextualPrompt(prompt, history)

    // Subscribe BEFORE posting so we don't miss early events.
    const sse = await this.openEventStream(baseUrl)
    const promptPromise = this.postPrompt(baseUrl, sessionID, contextualPrompt, callOpts)
      .catch((err: unknown) => ({ error: err instanceof Error ? err : new Error(String(err)) } as const))

    const timeoutMs = resolveTimeout()
    const timeoutAt = Date.now() + timeoutMs

    let surfacedError: string | null = null

    try {
      for await (const event of sse) {
        if (Date.now() > timeoutAt) {
          log.warn({ event: 'opencode.http.timeout', sessionID, timeoutMs }, 'http adapter timed out')
          yield `\n\n⚠️ 处理超时（已超过 ${Math.round(timeoutMs / 60000)} 分钟）`
          return
        }

        if (event.type === 'permission.asked') {
          this.routeAsk(event, baseUrl, sessionID, callOpts)
          continue
        }

        const errEvent = this.isErrorEvent(event, sessionID)
        if (errEvent) {
          surfacedError = errEvent.error
          continue
        }

        const { text } = this.inspectHttpEvent(event, sessionID, callOpts)
        if (text) yield text

        if (this.isIdleEvent(event, sessionID)) {
          break
        }
      }
    } finally {
      sse.close()
    }

    const result = await promptPromise
    if (result && typeof result === 'object' && 'error' in result) {
      log.warn({ event: 'opencode.http.prompt_failed', err: String(result.error) }, 'prompt POST failed')
      yield `opencode failed: ${result.error.message}`
      return
    }
    if (surfacedError) {
      yield `opencode session error: ${surfacedError}`
    }
  }

  // ─── permission bridge ────────────────────────────────────────────────

  /**
   * Decide how to handle a `permission.asked` SSE event:
   *   - If `this.approvalBus` is set AND has a notifier installed AND the
   *     call carries enough IM context (threadId + platform) → register a
   *     synthetic pending so the user gets an IM card; the bus's resolve
   *     callback POSTs the decision back to opencode via /permission/.../reply.
   *   - Otherwise → fall back to `once`. Without an IM channel there's no
   *     human to ask, and a plain `reject` would surface as a tool-call
   *     failure mid-conversation which is worse UX than allowing.
   *
   * Fire-and-forget: the SSE loop must keep draining other events while the
   * bridge waits for the user. The bus enforces its own timeout (5 min by
   * default) so we never deadlock the SSE loop.
   */
  private routeAsk(event: OpencodeEvent, baseUrl: string, ocSessionID: string, opts: AgentSendOpts): void {
    const props = event.properties ?? {}
    const reqId = props.id
    if (typeof reqId !== 'string') return

    const fallback = (): void => {
      this.replyPermission(baseUrl, reqId, 'once').catch((err: unknown) => {
        log.warn({ event: 'opencode.http.ask_fallback_failed', err: String(err), reqId })
      })
    }

    const bus = this.approvalBus
    const canBridge = bus !== null && bus.hasNotifier()
      && typeof opts.threadId === 'string' && opts.threadId.length > 0
      && typeof opts.platform === 'string' && opts.platform.length > 0

    if (!canBridge) {
      fallback()
      return
    }

    const ctx = {
      threadId: opts.threadId as string,
      platform: opts.platform as string,
      userId: opts.userId ?? '',
      channelId: opts.channelId ?? '',
    }
    const dispatch = (decision: Decision): void => {
      const wire = decisionToOpencodeReply(decision)
      this.replyPermission(baseUrl, reqId, wire.reply, wire.message).catch((err: unknown) => {
        log.warn({ event: 'opencode.http.ask_reply_failed', err: String(err), reqId })
      })
    }

    bus!.registerSyntheticPending({
      runId: ocSessionID,  // opencode session id IS the run id from the bus's POV
      reqId,
      toolName: typeof props.permission === 'string' ? props.permission : 'permission',
      input: {
        ...(Array.isArray(props.patterns) ? { patterns: props.patterns } : {}),
        ...(props.metadata && typeof props.metadata === 'object' ? props.metadata : {}),
      },
      ctx,
      dispatch,
    }).catch((err: unknown) => {
      // Bus rejected (e.g. notifier removed mid-flight). Safety: fall back.
      log.warn({ event: 'opencode.http.bridge_register_failed', err: String(err), reqId })
      fallback()
    })
  }

  /**
   * Build the session-level permission ruleset to append to opencode's
   * agent defaults. See createSession's docstring for policy rationale.
   *
   * The returned rules are flat `{permission, pattern, action}` objects
   * matching opencode's `Permission.Rule` schema.
   */
  private buildSessionRuleset(): Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }> {
    const gate = (process.env.IMHUB_OPENCODE_GATE || 'medium').toLowerCase()
    const ask = (permission: string) => ({ permission, pattern: '*', action: 'ask' as const })
    if (gate === 'none') return []
    if (gate === 'strict') return [ask('edit'), ask('write'), ask('patch'), ask('bash')]
    if (gate === 'loose') return [ask('edit'), ask('write')]
    return [ask('edit'), ask('write'), ask('patch')]  // medium (default)
  }

  /**
   * PATCH a resumed session with our gate ruleset so subsequent tool calls
   * surface as `permission.asked` events for the bridge. opencode's update
   * endpoint merges (current + payload) — payload comes last and wins under
   * findLast semantics. Idempotent across im-hub restarts but NOT within a
   * single process: the caller (sendPrompt) gates on rulesetApplied.
   */
  private async applyRuleset(baseUrl: string, sessionID: string): Promise<void> {
    const ruleset = this.buildSessionRuleset()
    if (ruleset.length === 0) return  // gate=none
    const res = await this.fetchImpl(`${baseUrl}/session/${sessionID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: ruleset }),
    })
    if (!res.ok) {
      throw new Error(`opencode session update failed: HTTP ${res.status}`)
    }
    await res.text().catch(() => '')
    log.info({ event: 'opencode.http.ruleset_applied', sessionID, gate: process.env.IMHUB_OPENCODE_GATE || 'medium' },
      'applied gate ruleset to resumed session')
  }

  // ─── HTTP plumbing ──────────────────────────────────────────────────────

  private async createSession(baseUrl: string, opts: AgentSendOpts): Promise<string> {
    // Session-level permission overrides for IM-launched runs.
    //
    // Why we override at all:
    //   opencode's built-in `build` agent ships with a `*: allow` catch-all
    //   (agent.ts:86-103 in the upstream repo). With findLast semantics,
    //   that swallows mutating tools like edit/write/patch unless we
    //   *append* stricter rules whose specificity wins.
    //
    // The "medium" policy (default):
    //   - edit / write / patch → ask: any time the assistant wants to
    //     mutate files, surface an IM card. These are the operations a
    //     user wants to "拍板".
    //   - bash is intentionally NOT gated: IM-driven exploration involves
    //     a flood of `ls` / `cat` / `git status` and asking on every one
    //     would drown the user. Mutations the LLM does via bash (rm,
    //     npm install, git commit) aren't caught here — that's a known
    //     gap; revisit if it bites in practice.
    //   - external_directory is already `ask` by default for paths
    //     outside the cwd / skill whitelist; we don't need to repeat it
    //     and it would be surprising to override.
    //
    // Override path: env IMHUB_OPENCODE_GATE=strict|loose|none flips this
    // policy without redeploy:
    //   strict → bash also asks
    //   loose  → only write+edit (drop patch)
    //   none   → no override (mostly for debugging)
    const body: Record<string, unknown> = {
      title: 'im-hub session',
    }
    // Plan mode: route through opencode's built-in `plan` agent and skip our
    // medium-gate ruleset entirely (plan agent's edit-deny-except-plans
    // policy is already stricter than the IM gate would impose).
    if (opts.planMode) {
      body.agent = 'plan'
    } else {
      body.permission = this.buildSessionRuleset()
    }
    const res = await this.fetchImpl(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`opencode session create failed: HTTP ${res.status} ${await safeText(res)}`)
    }
    const json = await res.json() as { id?: string }
    if (!json.id) throw new Error('opencode session create returned no id')
    log.info(
      {
        event: 'opencode.http.session_created',
        sessionID: json.id,
        cwd: resolveAgentCwd('opencode', opts),
      },
      'session created',
    )
    return json.id
  }

  private async postPrompt(
    baseUrl: string,
    sessionID: string,
    prompt: string,
    opts: AgentSendOpts,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
    }
    if (opts.model) body.model = opts.model
    if (opts.variant) body.variant = opts.variant
    // planMode forces the plan agent on every turn, including resumed sessions
    // that were originally created under build. opencode's per-message `agent`
    // field overrides the session's default agent for this single turn.
    if (opts.planMode) body.agent = 'plan'
    const res = await this.fetchImpl(`${baseUrl}/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`opencode prompt failed: HTTP ${res.status} ${await safeText(res)}`)
    }
    // Drain the body to free the connection slot — events stream via SSE.
    await res.text().catch(() => '')
  }

  private async replyPermission(
    baseUrl: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { reply }
    if (reply === 'reject' && message) body.message = message
    const res = await this.fetchImpl(`${baseUrl}/permission/${requestId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`opencode permission reply HTTP ${res.status}`)
    }
  }

  private async openEventStream(baseUrl: string): Promise<EventStream> {
    const res = await this.fetchImpl(`${baseUrl}/event`, {
      headers: { Accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) {
      throw new Error(`opencode event stream failed: HTTP ${res.status}`)
    }
    return new EventStream(res.body)
  }
}

/**
 * Map a bus Decision to opencode's permission.reply schema.
 *
 * Mapping rules:
 *   - allow            → once   (one-shot grant; matches what TUI sends)
 *   - allow + autoAllowFurther → once on the wire; the bus has already
 *     registered an im-side auto-allow rule by side effect (see
 *     ApprovalBus.cancelPending). We deliberately do NOT promote to
 *     opencode's `always` because that would persist a ruleset addition on
 *     the opencode session, which is heavier scope than the IM rule.
 *   - deny + message   → reject (+ message). opencode surfaces this as a
 *     CorrectedError ("user rejected … with feedback"), giving the LLM a
 *     useful hint instead of a bare reject.
 *   - deny             → reject
 */
function decisionToOpencodeReply(decision: Decision): { reply: 'once' | 'always' | 'reject'; message?: string } {
  if (decision.behavior === 'allow') return { reply: 'once' }
  return decision.message
    ? { reply: 'reject', message: decision.message }
    : { reply: 'reject' }
}

function resolveTimeout(): number {
  const raw = process.env.OPENCODE_TIMEOUT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_TIMEOUT_MS
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500) } catch { return '' }
}

/**
 * Minimal SSE parser. opencode's /event endpoint emits `data: <JSON>\n\n`
 * frames; we ignore other SSE fields (`event:`, `id:`, `retry:`) — opencode
 * doesn't use them. close() releases the underlying reader so the server's
 * heartbeat path detects the disconnect.
 *
 * The reader's exact static type clashes between Node's `stream/web` and
 * DOM's `ReadableStreamDefaultReader` (the latter has the extra `readMany`
 * member). At runtime fetch() returns whatever the host provides; we only
 * need read() / cancel() — declared locally so TS picks the narrow shape.
 */
interface MinimalReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>
  cancel(): Promise<void>
}

export class EventStream implements AsyncIterable<OpencodeEvent> {
  private reader: MinimalReader
  private decoder = new TextDecoder('utf-8')
  private buf = ''
  private closed = false

  constructor(body: NonNullable<Response['body']>) {
    this.reader = body.getReader() as unknown as MinimalReader
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { void this.reader.cancel() } catch { /* ignore */ }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<OpencodeEvent> {
    while (!this.closed) {
      const { value, done } = await this.reader.read()
      if (done) return
      if (!value) continue
      this.buf += this.decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = this.buf.indexOf('\n\n')) !== -1) {
        const frame = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        const evt = parseSseFrame(frame)
        if (evt) yield evt
      }
    }
  }
}

function parseSseFrame(frame: string): OpencodeEvent | null {
  let payload = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      payload += line.slice(5).trimStart()
    }
  }
  if (!payload) return null
  try {
    return JSON.parse(payload) as OpencodeEvent
  } catch {
    return null
  }
}

export type { OpencodeEvent }
