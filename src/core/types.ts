// im-hub core types

import type { Logger } from 'pino'

/**
 * Message received from a messenger platform
 */
export interface Message {
  id: string
  threadId: string
  userId: string
  text: string
  timestamp: Date
  channelId: string
}

/**
 * Chat message for conversation history
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

/**
 * Discriminated union for parsed messages
 * Each variant has a unique `type` field for type-safe pattern matching
 */
export type ParsedMessage =
  | { type: 'default'; prompt: string }
  | { type: 'command'; command: 'start' | 'status' | 'help' | 'agents' | 'new' }
  | { type: 'agentCommand'; command: string; prompt: string }
  | { type: 'agent'; agent: string; prompt: string }
  | { type: 'audit'; args: string }
  | { type: 'router'; args: string }
  | { type: 'workspaces'; args: string }
  | { type: 'schedule'; args: string }
  | { type: 'job'; args: string }
  | { type: 'model'; args: string }
  | { type: 'think'; args: string }
  | { type: 'stats'; args: string }
  | { type: 'sessions'; args: string }
  | { type: 'approval'; args: string }
  | { type: 'plan'; args: string }
  | { type: 'error'; prompt: string; error: string }

/**
 * Message context passed through the processing pipeline
 */
export interface MessageContext {
  message: Message
  platform: string
  channelId: string
  agent?: string
  session?: Session
  /** Unique trace id generated at message ingestion */
  traceId?: string
  /** Child logger bound to this request's traceId */
  logger?: Logger
}

/**
 * Session state for a conversation
 * Keyed by `${platform}:${channelId}:${threadId}` for uniqueness
 */
export interface Session {
  id: string
  channelId: string
  threadId: string
  platform: string
  agent: string
  createdAt: Date
  lastActivity: Date
  ttl: number
  messages: ChatMessage[]
  /** Current model (provider/model format) */
  model?: string
  /** Thinking depth variant */
  variant?: string
  /** Per-session usage roll-up. Updated by callAgentWithHistory after every
   *  successful agent invocation. Persisted with the session metadata so
   *  /stats survives restart. */
  usage?: SessionUsage
  /** Active subtask id for /switch routing */
  activeSubtaskId?: number | null
  subtasks?: SubtaskMeta[]
  subtaskCounter?: number
  /** UUID we pre-allocate for the claude-code adapter so multiple turns in
   *  the same im-hub conversation share one resumable claude session
   *  (`claude --resume <uuid>`). Persists across restarts. */
  claudeSessionId?: string
  /** Set to true after the first successful claude-code run on this session.
   *  cli uses it to decide between `--session-id` (fresh, allowed once) and
   *  `--resume` (subsequent turns). Cleared by /new. */
  claudeSessionPrimed?: boolean
  /** opencode session id (`ses_…`) discovered from opencode's first JSON event
   *  on a fresh run. Subsequent turns pass `--session <id>` so opencode
   *  resumes the same conversation from its own DB and im-hub no longer needs
   *  to stitch the history into the prompt. Cleared by /new. */
  opencodeSessionId?: string
  /** codex thread id (UUID) discovered from codex's `thread.started` event on
   *  a fresh run. Subsequent turns spawn `codex exec resume <id> …` so codex
   *  continues the same session from its own ~/.codex/sessions store. Cleared
   *  by /new. */
  codexSessionId?: string
  /** Plan mode flag — toggled by /plan on / /plan off. When true:
   *    • claude-code adapter spawns with `--permission-mode plan` and bypasses
   *      the IM approval bus (plan mode is read-only, no mutations to gate).
   *    • opencode adapter routes through the built-in `plan` agent and skips
   *      the medium-gate ruleset PATCH (plan agent's deny-edit policy is
   *      already stricter than the IM gate).
   *  Persists across turns and `/oc`↔`/cc` agent switches; cleared by /new. */
  planMode?: boolean
}

export interface SessionUsage {
  turns: number
  costUsd: number
  promptChars: number
  responseChars: number
  durationMsTotal: number
  /** ISO string of first invocation */
  startedAt: string
}

/** Lightweight subtask metadata stored in parent session */
export interface SubtaskMeta {
  id: number
  agent: string
  prompt: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: string
  createdAt: Date
  completedAt?: Date
}

/**
 * Adapter interface for messenger platforms (WeChat, Feishu, Telegram)
 */
export interface MessengerAdapter {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void
  sendMessage(threadId: string, text: string): Promise<void>
  /**
   * Send typing indicator to show the bot is processing
   * @param threadId - The conversation thread ID
   * @param isTyping - true to start typing indicator, false to stop
   */
  sendTyping?(threadId: string, isTyping: boolean): Promise<void>
  /**
   * Send an interactive card (Feishu only)
   * @param threadId - The conversation thread ID
   * @param card - The card JSON object
   */
  sendCard?(threadId: string, card: unknown): Promise<void>
  /**
   * Send a "thinking" placeholder message (e.g. 🤔 思考中…) and return a
   * dismiss handle. Adapters that can delete or update their own messages
   * (Feishu) should return a callable that removes the placeholder before
   * the real response is sent. Adapters that cannot recall (WeChat iLink)
   * should still send the placeholder and return undefined — the placeholder
   * lingers in the chat but at least gives the user immediate feedback.
   * Adapters that prefer their native typing indicator can omit this method.
   */
  sendThinking?(threadId: string, text: string): Promise<ThinkingHandle | undefined>
  /**
   * Subscribe to inline-button (callback_query) events. Adapters that support
   * native interactive buttons (Telegram inline keyboard, Feishu card actions
   * once we wire them) call the handler when a user taps a button. Adapters
   * without native button support simply omit this method — approval-router
   * falls back to its text/y-n flow.
   *
   * Idempotent: re-registering replaces the previous handler.
   */
  onButtonCallback?(handler: (cb: ButtonCallback) => Promise<void>): void
  /**
   * Send an approval prompt as a rich card with action buttons. When this
   * method is implemented, approval-router prefers it over plain
   * sendMessage. The returned messageId is later passed to editApprovalCard
   * so the card can be replaced with the outcome (✅ / ❌ / ⏱).
   *
   * Adapters that don't implement this fall back to sendMessage(text) — the
   * text path remains the canonical approval channel for Feishu / WeChat /
   * any IM that doesn't have native button support.
   */
  sendApprovalCard?(threadId: string, prompt: ApprovalCardPrompt): Promise<{ messageId: string }>
  /**
   * Replace the body of an approval card after the request has been resolved
   * (allowed / denied / timed out). Best-effort: failure is logged and
   * swallowed by the router, since the underlying approval has already
   * resolved on the bus side.
   */
  editApprovalCard?(threadId: string, messageId: string, outcome: ApprovalCardOutcome): Promise<void>
}

/**
 * Inline-button tap event surfaced by adapters that implement
 * onButtonCallback. The data field is opaque to the adapter; consumers
 * (approval-router, future button consumers) parse it.
 *
 * ack MUST be called within ~1s on Telegram or the client shows a stuck
 * "loading" spinner — adapters wrap their platform-native ack so callers
 * can stay platform-agnostic.
 */
export interface ButtonCallback {
  /** Raw callback_data string (Telegram caps at 64 bytes UTF-8). */
  data: string
  threadId: string
  userId: string
  /** Display name for the user who tapped (e.g. "@benking" or first_name).
   *  Used for "已批准 by @benking" rendering. Optional — adapters that
   *  can't easily resolve a display name should leave it undefined. */
  userDisplay?: string
  /** ID of the message that owned the button — passed back to
   *  editApprovalCard for in-place updates. */
  messageId: string
  /** Acknowledge the button tap to the platform. Optional toast text
   *  (Telegram shows it briefly above the chat). Errors are swallowed. */
  ack: (text?: string) => Promise<void>
}

/**
 * Payload handed to sendApprovalCard. inputJson is already truncated to a
 * display-safe length by the caller (router) — adapters should render it
 * as-is in a code block.
 */
export interface ApprovalCardPrompt {
  /** Bus-side request id; embedded in callback_data so the button click
   *  knows which approval to resolve. Adapters must not depend on its
   *  internal format. */
  reqId: string
  toolName: string
  /** Stringified input, already length-capped. May contain newlines. */
  inputJson: string
  /** 'normal' = ask user; 'auto-allow' = grace window before automatic
   *  allow (only the deny button is meaningful). */
  mode: 'normal' | 'auto-allow'
  /** Auto-allow grace window in seconds, present iff mode === 'auto-allow'. */
  graceSeconds?: number
}

/**
 * Outcome rendered into a card after the approval is resolved. The card's
 * action buttons are removed during this edit so the user can no longer
 * tap a stale button.
 */
export interface ApprovalCardOutcome {
  decision:
    | 'allowed'           // user said yes
    | 'allowed-pinned'    // user said yes + auto-allow this kind in session
    | 'denied'            // user said no
    | 'denied-revoked'    // user said no while a previous auto-allow rule was in effect
    | 'expired'           // approval-bus timed out before any decision
  /** "@user" or first name of the human who decided, if known. */
  byUserDisplay?: string
  atDate: Date
}

/** Optional callback returned by sendThinking; invoked once the real response
 *  is ready, to remove or otherwise hide the placeholder. */
export type ThinkingHandle = () => Promise<void>

/**
 * Optional per-call context piped from the IM router into the agent. Lets
 * adapters (e.g. ClaudeCodeAdapter) route side-channel events back to the
 * originating IM conversation — for instance, permission prompts surfaced
 * via approval-bus.
 *
 * All fields optional so non-IM call sites (web, scheduler, intent-llm) can
 * keep calling sendPrompt without adornment.
 */
export interface AgentSendOpts {
  model?: string
  variant?: string
  threadId?: string
  platform?: string
  userId?: string
  channelId?: string
  /** Optional UUID to bind to the agent's own resumable-session concept.
   *  Currently honoured by the claude-code adapter (passed as
   *  `--session-id` for first call, `--resume` for subsequent calls) so
   *  multi-turn IM conversations share one resumable claude session and
   *  the user can later `claude --resume <uuid>` to continue from their
   *  terminal. Other adapters ignore this. */
  agentSessionId?: string
  /** When true, the adapter should resume an existing session under
   *  `agentSessionId` rather than create a new one. claude-code translates
   *  this to `--resume <uuid>` instead of `--session-id <uuid>`. */
  agentSessionResume?: boolean
  /** Optional one-shot callback for adapters whose CLI generates the session
   *  id itself (rather than letting im-hub pre-allocate). opencode emits
   *  `sessionID` in every JSON event; the adapter calls this when it sees
   *  the id so cli can persist it on the im-hub session row for next turn.
   *  Idempotent: same id may fire multiple times per spawn. */
  onAgentSessionId?: (id: string) => void
  /** Optional callback for adapters that surface usage data inline (cost +
   *  tokens). opencode's `step_finish` event carries this; cli accumulates
   *  the deltas to feed `recordUsage` so /stats reflects opencode cost. */
  onUsage?: (delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number }) => void
  /** When true, the adapter should run the agent in plan / read-only mode.
   *  claude-code translates this to `--permission-mode plan`; opencode
   *  translates it to `--agent plan` (stdio) or `agent: 'plan'` in the HTTP
   *  body. Other adapters ignore this. See Session.planMode for lifecycle. */
  planMode?: boolean
}

/**
 * Adapter interface for AI coding agents (Claude Code, Codex, Copilot)
 *
 * sendPrompt returns an AsyncGenerator for streaming responses.
 * Each yielded string is a complete message chunk.
 * The generator throws on error — caller catches and handles.
 */
export interface AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  sendPrompt(sessionId: string, prompt: string, history?: ChatMessage[], opts?: AgentSendOpts): AsyncGenerator<string>
  isAvailable(): Promise<boolean>
}

/**
 * Configuration for the im-hub instance
 */
export interface Config {
  messengers: string[]
  agents: string[]
  defaultAgent: string
  [key: string]: unknown
}
