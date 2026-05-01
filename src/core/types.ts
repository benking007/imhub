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
}

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
