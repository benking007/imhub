// Claude Code agent adapter
// Uses --print --output-format stream-json for programmatic interaction
//
// Permission flow has two modes, decided per-call in prepareCommand():
//
//   Approval-routed (default when IM context is present and the bus is up):
//     --permission-mode default
//     --permission-prompt-tool mcp__imhub__request
//     --mcp-config <tmpfile>
//   The MCP sidecar (mcp-approval-server.js) is registered via --mcp-config;
//   it connects to im-hub's approval-bus over a unix socket, and im-hub
//   surfaces approval prompts to the originating IM thread.
//
//   Legacy "dontAsk" fallback (env IMHUB_APPROVAL_DISABLED=1, OR no IM
//   thread context, OR approvalBus not started):
//     --permission-mode dontAsk
//   Previous behavior — Claude leans entirely on PreToolUse hooks in
//   ~/.claude/settings.json plus the CLAUDE_VIA_IM env signal injected by
//   im-hub.service. Use this when human approval over IM isn't available.
//
// IMPORTANT: every per-spawn resource (runId, mcp-config dir, registry
// entry) lives in the SpawnPlan returned by prepareCommand — never on the
// adapter instance. The adapter is a singleton and concurrent IM threads
// would otherwise clobber each other's state mid-spawn.

import { randomUUID } from 'crypto'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_PATH = join(__dirname, 'mcp-approval-server.js')
const log = rootLogger.child({ component: 'agent.claude-code' })

const BASE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'] as const

/** First call with a UUID: --session-id (creates the session under that id).
 *  Subsequent calls: --resume (continues from existing). Mixing them up gets
 *  you "Session ID already in use" or "session not found". */
function sessionFlag(opts: AgentSendOpts): string[] {
  if (!opts.agentSessionId) return []
  return opts.agentSessionResume
    ? ['--resume', opts.agentSessionId]
    : ['--session-id', opts.agentSessionId]
}

interface ClaudeEvent {
  type: string
  message?: {
    content: Array<{ type: string; text?: string; thinking?: string }>
    role: string
  }
}

export class ClaudeCodeAdapter extends AgentBase {
  readonly name = 'claude-code'
  readonly aliases = ['cc', 'claude', 'claudecode']

  protected get commandName(): string { return 'claude' }

  /**
   * Legacy/fallback args — used when approval routing is disabled or not
   * applicable (no IM context, bus down, IMHUB_APPROVAL_DISABLED=1).
   *
   * planMode override: when opts.planMode is true we hand claude
   * `--permission-mode plan` regardless of fallback path. plan is read-only
   * by design so the IM approval bus has nothing to gate, and dontAsk would
   * silently re-allow mutations the user explicitly opted out of.
   */
  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const mode = opts.planMode ? 'plan' : 'dontAsk'
    return [
      ...sessionFlag(opts),
      ...BASE_ARGS,
      '--permission-mode', mode,
      prompt,
    ]
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // Cwd is computed once and shared by all return paths below — both the
    // approval-routed path and every fallback ("dontAsk", missing IM context,
    // tmpdir failure, etc.). Skipping cwd on the fallbacks would silently
    // demote those calls back to im-hub's "/" cwd and leak across memory.
    const cwd = resolveAgentCwd(this.name, opts)

    // Plan mode short-circuits the approval-bus pipeline: claude's `plan`
    // permission mode is strictly read-only, so there are no mutating tools
    // for the IM bridge to gate. Skipping the mcp-config tmpdir + bus run
    // registration also keeps cleanup trivial. buildArgs picks `--permission-mode plan`
    // when opts.planMode is true.
    if (opts.planMode) {
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    if (process.env.IMHUB_APPROVAL_DISABLED === '1') {
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    const sockPath = approvalBus.getSocketPath()
    if (!sockPath) return { args: this.buildArgs(prompt, opts), cwd } // bus not started

    const { threadId, platform, channelId, userId } = opts
    if (!threadId || !platform || !channelId) {
      // Non-IM call (web/scheduler/intent-llm) — no thread to route prompts to.
      // resolveAgentCwd returns undefined here too, so cwd ends up undefined and
      // the spawn inherits im-hub's cwd, matching the historical behavior.
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    const runId = randomUUID()

    let configDir: string
    try {
      configDir = await mkdtemp(join(tmpdir(), 'imhub-mcp-'))
    } catch (err) {
      log.warn({ event: 'claude.approval.mkdtemp_failed', err: String(err) },
        'Falling back to dontAsk: cannot create mcp-config tmpdir')
      return { args: this.buildArgs(prompt, opts), cwd }
    }
    const configPath = join(configDir, 'mcp.json')

    const config = {
      mcpServers: {
        imhub: {
          command: process.execPath,
          args: [SIDECAR_PATH],
          env: {
            IMHUB_APPROVAL_SOCK: sockPath,
            IMHUB_RUN_ID: runId,
          },
        },
      },
    }

    try {
      await writeFile(configPath, JSON.stringify(config), 'utf8')
    } catch (err) {
      log.warn({ event: 'claude.approval.write_config_failed', err: String(err) },
        'Falling back to dontAsk: cannot write mcp-config')
      try { await rm(configDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    approvalBus.registerRun(runId, {
      threadId, platform, userId: userId ?? '', channelId,
    })

    log.info({ event: 'claude.approval.routed', runId, threadId, platform },
      'Claude run routed via approval-bus')

    // Closure captures runId + configDir locally — concurrent runs each have
    // their own copy, so cleanup never deletes another spawn's tmpdir.
    return {
      args: [
        ...sessionFlag(opts),
        // ORDER MATTERS: --mcp-config takes <configs...> (variadic). Place it
        // before another `-X` flag so it sees exactly one file path, not the
        // prompt as a second config file.
        '--mcp-config', configPath,
        ...BASE_ARGS,
        '--permission-mode', 'default',
        '--permission-prompt-tool', 'mcp__imhub__request',
        prompt,
      ],
      cwd,
      cleanup: async () => {
        approvalBus.unregisterRun(runId)
        try { await rm(configDir, { recursive: true, force: true }) } catch { /* ignore */ }
      },
    }
  }

  protected extractText(event: unknown): string {
    const msg = event as ClaudeEvent
    if (msg.type === 'assistant' && msg.message?.content) {
      const parts: string[] = []
      for (const item of msg.message.content) {
        if (item.type === 'text' && item.text) parts.push(item.text)
      }
      return parts.join('')
    }
    return ''
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter()

// Test-only escape hatch — drives prepareCommand/buildArgs without going
// through the spawnStream pipeline.
export const _testInternals = {
  async prepareCommand(adapter: ClaudeCodeAdapter, prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // @ts-expect-error — protected; tests reach in deliberately
    return adapter.prepareCommand(prompt, opts)
  },
  buildArgs(adapter: ClaudeCodeAdapter, prompt: string, opts: AgentSendOpts = {}): string[] {
    // @ts-expect-error
    return adapter.buildArgs(prompt, opts)
  },
}
