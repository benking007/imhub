// OpenAI Codex CLI agent adapter — `codex exec --json` driver.
//
// Multi-turn continuity (mirrors the opencode pattern):
//
//   First turn  — no opts.agentSessionId yet. Spawn `codex exec --json …`.
//                 The adapter watches for `thread.started.thread_id` and
//                 reports it back via opts.onAgentSessionId so cli persists
//                 it on the im-hub Session row (codexSessionId).
//   Later turns — opts.agentSessionId is the captured UUID. We spawn
//                 `codex exec resume <id> --json …` so codex continues from
//                 its own ~/.codex/sessions store. router.callAgentWithHistory
//                 honours agentSessionResume by zeroing effectiveHistory so
//                 we don't double-feed prior turns.
//
// Cwd: pinned to ~/.im-hub-workspaces/codex/ for IM calls (per agent-cwd.ts);
// codex reads its project AGENTS.md from cwd just like opencode.
//
// Usage roll-up: `turn.completed.usage` carries token counts (no cost). We
// forward input/output tokens via opts.onUsage so /stats reflects real codex
// usage. costUsd stays undefined until codex surfaces pricing.
//
// NOT in v1 (deferred):
//   - Per-tool approval routing. `codex exec` has no external approval hook;
//     it only takes the OS sandbox flag `-s read-only|workspace-write|
//     danger-full-access`. We currently pass `--full-auto` (= workspace-write
//     + auto-approve) to match prior behavior. A future iteration will route
//     approval like the claude-code MCP sidecar or the opencode SSE bus.
//   - planMode. Tied to the approval discussion — once we have a clean
//     read-only switch, we'll plumb opts.planMode → `-s read-only`.

import { execSync } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'agent.codex' })

/**
 * Codex's `bin/codex.js` wrapper (npm install -g @openai/codex) drops all
 * stdout when the parent spawns it with `stdio: ['ignore', 'pipe', 'pipe']`
 * — the wrapper relays its own stdio to the native binary via
 * `stdio: 'inherit'`, and that handoff fails to forward data through a
 * piped fd back to the grandparent. The native binary works fine when
 * called directly.
 *
 * Resolution: at startup, follow `which codex` → real path of wrapper →
 * `<codex-pkg>/node_modules/@openai/codex-<triple>/vendor/<triple>/codex/codex`.
 * Cache the result. If anything in the chain is missing (different install
 * layout, unsupported triple), fall back to the wrapper name and hope for
 * the best — at least the user sees a failure rather than silent 0-byte.
 *
 * Probed once per process; the cache lives module-level.
 */
let cachedBinary: string | null = null
let probed = false

function resolveCodexBinary(): string {
  if (probed) return cachedBinary ?? 'codex'
  probed = true

  try {
    const wrapper = execSync('command -v codex', { encoding: 'utf8' }).trim()
    if (!wrapper) return 'codex'

    const wrapperReal = realpathSync(wrapper)
    // wrapperReal e.g. /usr/local/lib/node_modules/@openai/codex/bin/codex.js
    const codexPkgRoot = dirname(dirname(wrapperReal))

    const triple = pickTriple(process.platform, process.arch)
    if (!triple) {
      log.warn({ platform: process.platform, arch: process.arch },
        'codex: unsupported platform, falling back to wrapper (stdio pipe bug applies)')
      return 'codex'
    }

    const platformPkg = pickPlatformPackage(process.platform, process.arch)
    if (!platformPkg) return 'codex'

    const candidates = [
      join(codexPkgRoot, 'node_modules', platformPkg, 'vendor', triple, 'codex', 'codex'),
      join(codexPkgRoot, 'vendor', triple, 'codex', 'codex'),
    ]
    for (const cand of candidates) {
      if (existsSync(cand)) {
        cachedBinary = cand
        log.info({ binary: cand }, 'codex: resolved native binary, bypassing wrapper')
        return cand
      }
    }
    log.warn({ tried: candidates }, 'codex: native binary not found, using wrapper (may break in IM)')
  } catch (err) {
    log.warn({ err: String(err) }, 'codex: binary resolution failed, using wrapper')
  }
  return 'codex'
}

function pickTriple(platform: string, arch: string): string | null {
  if (platform === 'linux') {
    if (arch === 'x64')   return 'x86_64-unknown-linux-musl'
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl'
  }
  if (platform === 'darwin') {
    if (arch === 'x64')   return 'x86_64-apple-darwin'
    if (arch === 'arm64') return 'aarch64-apple-darwin'
  }
  if (platform === 'win32') {
    if (arch === 'x64')   return 'x86_64-pc-windows-msvc'
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc'
  }
  return null
}

function pickPlatformPackage(platform: string, arch: string): string | null {
  const archKey = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!archKey) return null
  if (platform === 'linux')  return `@openai/codex-linux-${archKey}`
  if (platform === 'darwin') return `@openai/codex-darwin-${archKey}`
  if (platform === 'win32')  return `@openai/codex-win32-${archKey}`
  return null
}

interface CodexEvent {
  type: string
  thread_id?: string
  item?: {
    id?: string
    type?: string
    text?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    reasoning_output_tokens?: number
  }
  message?: string
  error?: string
  error_message?: string
}

const BASE_FLAGS = ['--json', '--full-auto', '--skip-git-repo-check'] as const

export class CodexAdapter extends AgentBase {
  readonly name = 'codex'
  readonly aliases = ['cx', 'openai', 'codexcli']

  /**
   * Override to bypass the codex wrapper's broken stdio handling — see
   * resolveCodexBinary() above. Falls back to "codex" (PATH lookup) if
   * native binary resolution fails.
   *
   * commandName drives `isAvailable()` (--version probe) AND the spawn binary,
   * so resolving here gets us both at once.
   */
  protected get commandName(): string {
    return resolveCodexBinary()
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    if (opts.agentSessionId && opts.agentSessionResume) {
      // `codex exec resume <UUID> [OPTIONS] [PROMPT]` — the SESSION_ID
      // positional has to come immediately after `resume`, before flags.
      return ['exec', 'resume', opts.agentSessionId, ...BASE_FLAGS, prompt]
    }
    return ['exec', ...BASE_FLAGS, prompt]
  }

  /**
   * codex reads its project-level AGENTS.md from spawn cwd, so for IM calls we
   * pin to ~/.im-hub-workspaces/codex/. Non-IM calls (web/scheduler) keep
   * cwd undefined and inherit im-hub's cwd. See agent-cwd.ts for rationale.
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    return {
      args: this.buildArgs(prompt, opts),
      cwd: resolveAgentCwd(this.name, opts),
    }
  }

  protected extractText(event: unknown): string {
    const e = event as CodexEvent
    // codex 0.128 emits assistant text inside item.completed where item.type
    // is "agent_message". The pre-v1 adapter looked for {type:"message"},
    // which never fires, so all output was being dropped on the floor.
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      return e.item.text
    }
    return ''
  }

  /**
   * Side-channel hook: capture session id (`thread.started`) and usage
   * (`turn.completed.usage`) without disrupting the text stream.
   */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as CodexEvent
    if (e.type === 'thread.started' && e.thread_id && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(e.thread_id) } catch { /* userland callback safety */ }
    }
    if (e.type === 'turn.completed' && e.usage && opts.onUsage) {
      const u = e.usage
      const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
      if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) {
        delta.tokensInput = u.input_tokens
      }
      if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) {
        delta.tokensOutput = u.output_tokens
      }
      // codex doesn't surface cost; leave delta.costUsd undefined.
      if (delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* userland callback safety */ }
      }
    }
  }

  protected handleError(_code: number, _stderr: string, errorMessage: string): string | null {
    if (errorMessage.includes('expired') || errorMessage.includes('过期')) {
      return '❌ Codex 账号已过期\n\n请运行 `codex login` 重新登录。'
    }
    if (errorMessage.includes('not found') || errorMessage.includes('不存在')) {
      return '❌ Codex 用户不存在，请重新登录\n\n请运行 `codex login` 重新登录。'
    }
    return null
  }
}

export const codexAdapter = new CodexAdapter()

// Test-only escape hatch — drives the protected hooks without going through
// the spawnStream pipeline.
export const _testInternals = {
  buildArgs(adapter: CodexAdapter, prompt: string, opts: AgentSendOpts = {}): string[] {
    // @ts-expect-error — protected; tests reach in deliberately
    return adapter.buildArgs(prompt, opts)
  },
  async prepareCommand(adapter: CodexAdapter, prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // @ts-expect-error
    return adapter.prepareCommand(prompt, opts)
  },
  extractText(adapter: CodexAdapter, event: unknown): string {
    // @ts-expect-error
    return adapter.extractText(event)
  },
  inspectEvent(adapter: CodexAdapter, event: unknown, opts: AgentSendOpts): void {
    // @ts-expect-error
    adapter.inspectEvent(event, opts)
  },
}
