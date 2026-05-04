// Per-agent working directory resolution for the IM context.
//
// Both Claude Code and opencode key their per-project memory / history off
// the spawned process's cwd. When im-hub runs as a systemd service, that cwd
// is "/" — so every IM thread, every direct-terminal session, and every
// background scheduler tick all share the SAME global memory bucket. This
// is the root cause of:
//
//   - The IM-only Claude not being able to carry a distinct CLAUDE.md role
//   - The user's terminal MEMORY.md getting polluted by IM auto-saves
//   - opencode's AGENTS.md being unable to differ between IM and terminal
//
// Fix: when we detect we're in an IM call (threadId + platform both set),
// pin the agent into a stable per-agent workspace under
// `~/.im-hub-workspaces/<agent>/`. Non-IM calls (web UI, scheduler,
// intent-llm judge) keep the inherited cwd, preserving prior behavior.
//
// Override path: `IMHUB_<AGENT>_CWD` env var beats everything (e.g.
// `IMHUB_CLAUDE_CODE_CWD=/srv/foo`). Useful for migration tests and for
// future per-tenant deployments.

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, writeFile, access } from 'fs/promises'
import type { AgentSendOpts } from './types.js'

/** Root for all per-agent IM workspaces. Kept stable so memory persists. */
export function imhubWorkspacesRoot(): string {
  return process.env.IMHUB_WORKSPACES_ROOT || join(homedir(), '.im-hub-workspaces')
}

/** Default cwd for a given agent under the workspaces root. */
export function defaultAgentCwd(agentName: string): string {
  return join(imhubWorkspacesRoot(), agentName)
}

/** Env var name for an explicit override on a given agent. */
function envKeyFor(agentName: string): string {
  // claude-code -> IMHUB_CLAUDE_CODE_CWD
  return `IMHUB_${agentName.replace(/-/g, '_').toUpperCase()}_CWD`
}

/**
 * Resolve the cwd to spawn an agent CLI in.
 *
 * Decision order:
 *   1. Env override `IMHUB_<AGENT>_CWD` always wins.
 *   2. If we're in an IM context (threadId + platform both present), pin to
 *      `~/.im-hub-workspaces/<agent>/`.
 *   3. Otherwise return undefined → adapter inherits im-hub's cwd. This
 *      keeps web/scheduler/intent-llm judge paths exactly as they were.
 */
export function resolveAgentCwd(agentName: string, opts: AgentSendOpts): string | undefined {
  const explicit = process.env[envKeyFor(agentName)]
  if (explicit) return explicit

  if (opts.threadId && opts.platform) {
    return defaultAgentCwd(agentName)
  }

  return undefined
}

/**
 * Idempotent: create the workspace dir and seed initial CLAUDE.md / AGENTS.md
 * if they don't exist. Existing files are NEVER overwritten — the user is free
 * to evolve them by hand or have the agent itself rewrite them via
 * auto-memory.
 *
 * Honors IMHUB_<AGENT>_CWD overrides — if set, we bootstrap THAT path
 * instead. Skips bootstrapping when the override is empty / unset and we
 * compute it from defaultAgentCwd; either way the resolved path is what
 * spawnStream will pass as cwd.
 */
export async function ensureAgentWorkspace(
  agentName: string,
  seed: { filename: string; content: string },
): Promise<string> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
  await mkdir(dir, { recursive: true })

  const seedPath = join(dir, seed.filename)
  try {
    await access(seedPath)
    // already exists — leave the user's customizations alone
  } catch {
    await writeFile(seedPath, seed.content, 'utf8')
  }

  return dir
}

/**
 * Bootstrap the workspaces for the two built-in CLI agents we ship by
 * default. Safe to call multiple times. Returns a summary suitable for
 * logging.
 *
 * Other agents (codex, copilot, ACP-imported) don't need cwd isolation
 * either because they don't have per-cwd memory, or because they're
 * remote — they'll pass through with cwd undefined like before.
 */
export async function bootstrapAgentWorkspaces(): Promise<Array<{ agent: string; dir: string }>> {
  const result: Array<{ agent: string; dir: string }> = []

  const claudeSeed = `# Claude Code — IM 入口工作区

> 这是 im-hub 通过 IM 唤起 Claude Code 时的专用工作目录。
> 与你直接在终端里跑 \`claude\` 时使用的全局配置 (~/.claude/CLAUDE.md) 隔离。
>
> 文件位置：${defaultAgentCwd('claude-code')}/CLAUDE.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Claude Code。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 你自己的 auto-memory 落在本目录的 \`memory/MEMORY.md\`
- 长期项目档案手写在本目录下，由 Claude 自己读取与维护
- 与终端里的 Claude 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（im-hub 层），长任务必须走 bgjob
`

  result.push({
    agent: 'claude-code',
    dir: await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: claudeSeed }),
  })

  const opencodeSeed = `# OpenCode — IM 入口工作区

> 这是 im-hub 通过 IM 唤起 opencode 时的专用工作目录。
> 与你直接在终端里跑 \`opencode\` 时使用的全局配置 (~/.config/opencode/AGENTS.md) 隔离。
>
> 文件位置：${defaultAgentCwd('opencode')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 opencode。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下的 PROJECT.md，由 opencode 自己读取与维护
- 与终端里的 opencode 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（im-hub 层），长任务必须走 bgjob
`

  result.push({
    agent: 'opencode',
    dir: await ensureAgentWorkspace('opencode', { filename: 'AGENTS.md', content: opencodeSeed }),
  })

  const codexSeed = `# Codex — IM 入口工作区

> 这是 im-hub 通过 IM 唤起 OpenAI Codex CLI 时的专用工作目录。
> 与你直接在终端里跑 \`codex\` 时使用的全局配置 (~/.codex/config.toml) 隔离。
>
> 文件位置：${defaultAgentCwd('codex')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Codex。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode 工作区互不干扰
- 与终端里的 codex 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（im-hub 层），长任务必须走 bgjob
- bgjob 数据目录：~/.codex/bgjobs/（与 claude / opencode 隔离）
  使用方式：\`/root/.codex/scripts/bgjob start <name> -- <cmd...>\`
- AGENTS.md 与 opencode 同名但工作区分离 —— codex 只读本目录的 AGENTS.md，
  不会读 ~/.im-hub-workspaces/opencode/AGENTS.md
`

  result.push({
    agent: 'codex',
    dir: await ensureAgentWorkspace('codex', { filename: 'AGENTS.md', content: codexSeed }),
  })

  return result
}
