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
