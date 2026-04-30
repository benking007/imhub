// GitHub Copilot CLI agent adapter
// Supports multiple installation methods:
// 1. GitHub CLI extension: `gh copilot` (recommended)
// 2. Standalone npm: `copilot` command
// 3. VS Code extension: bundled copilot CLI
// 4. Homebrew (macOS): `brew install copilot-cli`
// 5. WinGet (Windows): `winget install GitHub.Copilot`

import { access, constants, readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { AgentBase } from '../../../core/agent-base.js'
import { crossSpawn, isWindows, isMac } from '../../../utils/cross-platform.js'
import { logger as rootLogger } from '../../../core/logger.js'

// Installation method detection result
interface CopilotInstall {
  type: 'gh-ext' | 'standalone' | 'vscode' | 'homebrew' | 'winget'
  command: string
  argsPrefix: string[]
}

/** Check if a command exists and can be executed */
async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = crossSpawn(cmd, ['--version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

async function checkGHCopilot(): Promise<CopilotInstall | null> {
  if (!(await commandExists('gh'))) return null
  return new Promise((resolve) => {
    const proc = crossSpawn('gh', ['copilot', '--version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ type: 'gh-ext', command: 'gh', argsPrefix: ['copilot'] })
      } else {
        resolve(null)
      }
    })
  })
}

async function checkStandaloneCopilot(): Promise<CopilotInstall | null> {
  if (await commandExists('copilot')) {
    return { type: 'standalone', command: 'copilot', argsPrefix: [] }
  }
  return null
}

async function findVSCodeCopilot(): Promise<CopilotInstall | null> {
  if (isMac) {
    const macPath = join(
      homedir(),
      'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'
    )
    try {
      await access(macPath, constants.X_OK)
      return { type: 'vscode', command: macPath, argsPrefix: [] }
    } catch { /* fall through */ }
  }

  if (isWindows) {
    const extensionsDir = join(homedir(), '.vscode', 'extensions')
    try {
      const entries = await readdir(extensionsDir, { withFileTypes: true })
      const copilotDir = entries.find(
        (entry) => entry.isDirectory() && entry.name.startsWith('github.copilot-chat-')
      )
      if (copilotDir) {
        const copilotBin = join(extensionsDir, copilotDir.name, 'copilotCli', 'copilot.exe')
        try {
          await access(copilotBin, constants.X_OK)
          return { type: 'vscode', command: copilotBin, argsPrefix: [] }
        } catch { /* fall through */ }
      }
    } catch { /* ignore readdir errors */ }
  }

  const linuxPath = join(homedir(), '.vscode/extensions/github.copilot-chat/copilotCli/copilot')
  try {
    await access(linuxPath, constants.X_OK)
    return { type: 'vscode', command: linuxPath, argsPrefix: [] }
  } catch {
    return null
  }
}

/** TTL'd installation cache so a fresh install is picked up within 2min. */
const INSTALL_CACHE_TTL = 2 * 60 * 1000
let cachedInstall: CopilotInstall | null = null
let cachedAt = 0

async function detectCopilotInstall(): Promise<CopilotInstall | null> {
  if (cachedInstall && Date.now() - cachedAt < INSTALL_CACHE_TTL) return cachedInstall

  cachedInstall =
    (await checkGHCopilot()) ||
    (await checkStandaloneCopilot()) ||
    (await findVSCodeCopilot())
  cachedAt = Date.now()
  return cachedInstall
}

/**
 * Copilot adapter built on AgentBase. Differs from the other CLI agents
 * in two ways:
 *   1. The binary path is discovered async (gh / standalone / VSCode)
 *   2. The CLI is not JSONL — its stdout is plain text
 *
 * AgentBase already handles plain text via the JSON.parse fallback (yields
 * the line verbatim). We override commandName/buildArgs/extractText after
 * resolving the install, and use isAvailable() to short-circuit when no
 * install was found.
 */
class CopilotAdapter extends AgentBase {
  readonly name = 'copilot'
  readonly aliases = ['gh', 'github', 'copilotcli', 'ghcp']

  /** Resolved install, populated by isAvailable() and reused by spawn calls. */
  private resolvedInstall: CopilotInstall | null = null

  protected get commandName(): string {
    if (!this.resolvedInstall) {
      // Should never happen — sendPrompt awaits isAvailable() first. But if
      // someone calls spawnAndCollect directly we degrade by using a
      // sentinel that the spawn will fail on, surfaced via handleError.
      return 'copilot'
    }
    return this.resolvedInstall.command
  }

  protected buildArgs(prompt: string): string[] {
    const install = this.resolvedInstall
    if (!install) return ['-p', prompt, '-s']
    if (install.type === 'gh-ext') {
      return [...install.argsPrefix, 'suggest', prompt, '--prompt-only']
    }
    return [...install.argsPrefix, '-p', prompt, '-s']
  }

  protected extractText(event: unknown): string {
    // Copilot CLI is not JSONL; AgentBase's fallback already yields the
    // raw line. extractText is only consulted on successfully-parsed JSON,
    // which Copilot never emits.
    if (event && typeof event === 'object') {
      const e = event as Record<string, unknown>
      if (typeof e.content === 'string') return e.content
      if (typeof e.text === 'string') return e.text
    }
    return ''
  }

  async isAvailable(): Promise<boolean> {
    this.resolvedInstall = await detectCopilotInstall()
    return this.resolvedInstall !== null
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now()
    const ok = await this.isAvailable()
    return { ok, latencyMs: Date.now() - start }
  }

  protected handleError(_code: number, stderr: string, _errorMessage: string): string | null {
    if (stderr.includes('402') || stderr.includes('no quota') || stderr.includes('insufficient')) {
      return `❌ Copilot 额度不足，请检查您的 GitHub Copilot 订阅。

💡 可以使用以下命令切换到其他 Agent：
• /claude - 切换到 Claude Code
• /codex - 切换到 OpenAI Codex
• /agents - 查看所有可用 Agent`
    }
    return null
  }

  protected notAvailableMessage(): string {
    return `❌ Copilot CLI 未找到。

安装方式 (选择其一):
  npm i -g @github/copilot
  gh extension install github/gh-copilot
  brew install copilot-cli (macOS)
  winget install GitHub.Copilot (Windows)

或安装 VS Code Copilot Chat 扩展。`
  }

  // Override sendPrompt to short-circuit when not installed — gives a
  // friendlier message than spawnStream would after spawn failure.
  async *sendPrompt(sessionId: string, prompt: string, history?: import('../../../core/types.js').ChatMessage[], _opts?: { model?: string; variant?: string }): AsyncGenerator<string> {
    if (!(await this.isAvailable())) {
      yield this.notAvailableMessage()
      return
    }
    rootLogger.info({ component: `agent.${this.name}`, agent: this.name, install: this.resolvedInstall?.type }, '[copilot] sendPrompt')
    yield* super.sendPrompt(sessionId, prompt, history, _opts)
  }
}

export const copilotAdapter = new CopilotAdapter()
