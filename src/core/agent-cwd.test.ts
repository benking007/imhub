import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveAgentCwd,
  defaultAgentCwd,
  imhubWorkspacesRoot,
  ensureAgentWorkspace,
  bootstrapAgentWorkspaces,
} from './agent-cwd.js'

const FULL_IM_OPTS = { threadId: 'thread-A', platform: 'feishu', channelId: 'chan-1', userId: 'u1' }
const NO_IM_OPTS = { model: 'sonnet' }

describe('resolveAgentCwd', () => {
  let tmpRoot: string
  let prevRoot: string | undefined
  let prevClaudeOverride: string | undefined
  let prevOpencodeOverride: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'imhub-cwdtest-'))
    prevRoot = process.env.IMHUB_WORKSPACES_ROOT
    prevClaudeOverride = process.env.IMHUB_CLAUDE_CODE_CWD
    prevOpencodeOverride = process.env.IMHUB_OPENCODE_CWD
    process.env.IMHUB_WORKSPACES_ROOT = tmpRoot
    delete process.env.IMHUB_CLAUDE_CODE_CWD
    delete process.env.IMHUB_OPENCODE_CWD
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.IMHUB_WORKSPACES_ROOT
    else process.env.IMHUB_WORKSPACES_ROOT = prevRoot
    if (prevClaudeOverride === undefined) delete process.env.IMHUB_CLAUDE_CODE_CWD
    else process.env.IMHUB_CLAUDE_CODE_CWD = prevClaudeOverride
    if (prevOpencodeOverride === undefined) delete process.env.IMHUB_OPENCODE_CWD
    else process.env.IMHUB_OPENCODE_CWD = prevOpencodeOverride
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns default workspace dir when full IM context is present', () => {
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe(join(tmpRoot, 'claude-code'))
  })

  it('returns undefined for non-IM call (web/scheduler), preserving inherited cwd', () => {
    expect(resolveAgentCwd('claude-code', NO_IM_OPTS)).toBeUndefined()
  })

  it('returns undefined when only one of threadId/platform is set', () => {
    expect(resolveAgentCwd('claude-code', { threadId: 't1' })).toBeUndefined()
    expect(resolveAgentCwd('claude-code', { platform: 'feishu' })).toBeUndefined()
  })

  it('env override beats default IM dir', () => {
    process.env.IMHUB_CLAUDE_CODE_CWD = '/srv/explicit'
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe('/srv/explicit')
  })

  it('env override also wins for non-IM calls (admin escape hatch)', () => {
    process.env.IMHUB_CLAUDE_CODE_CWD = '/srv/explicit'
    expect(resolveAgentCwd('claude-code', NO_IM_OPTS)).toBe('/srv/explicit')
  })

  it('env key respects per-agent naming (hyphen to underscore, uppercase)', () => {
    process.env.IMHUB_OPENCODE_CWD = '/srv/oc'
    expect(resolveAgentCwd('opencode', FULL_IM_OPTS)).toBe('/srv/oc')
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe(join(tmpRoot, 'claude-code'))
  })

  it('IMHUB_WORKSPACES_ROOT moves the default for every agent at once', () => {
    expect(imhubWorkspacesRoot()).toBe(tmpRoot)
    expect(defaultAgentCwd('claude-code')).toBe(join(tmpRoot, 'claude-code'))
    expect(defaultAgentCwd('opencode')).toBe(join(tmpRoot, 'opencode'))
  })
})

describe('ensureAgentWorkspace', () => {
  let tmpRoot: string
  let prevRoot: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'imhub-cwdtest-'))
    prevRoot = process.env.IMHUB_WORKSPACES_ROOT
    process.env.IMHUB_WORKSPACES_ROOT = tmpRoot
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.IMHUB_WORKSPACES_ROOT
    else process.env.IMHUB_WORKSPACES_ROOT = prevRoot
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('creates the dir and seed file when missing', async () => {
    const dir = await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# seed' })
    expect(dir).toBe(join(tmpRoot, 'claude-code'))
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# seed')
  })

  it('does NOT overwrite an existing seed file', async () => {
    const dir = join(tmpRoot, 'claude-code')
    await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# seed' })
    await writeFile(join(dir, 'CLAUDE.md'), 'USER EDITED', 'utf8')
    await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# new seed' })
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('USER EDITED')
  })

  it('is fully idempotent across many calls', async () => {
    for (let i = 0; i < 5; i++) {
      await ensureAgentWorkspace('opencode', { filename: 'AGENTS.md', content: '# x' })
    }
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toBe('# x')
  })

  it('honors IMHUB_<AGENT>_CWD override and bootstraps THAT path instead', async () => {
    const altDir = join(tmpRoot, 'custom-spot')
    process.env.IMHUB_CLAUDE_CODE_CWD = altDir
    try {
      const dir = await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# alt' })
      expect(dir).toBe(altDir)
      expect(await readFile(join(altDir, 'CLAUDE.md'), 'utf8')).toBe('# alt')
      let defaultExists = false
      try { await access(join(tmpRoot, 'claude-code')); defaultExists = true } catch { /* expected */ }
      expect(defaultExists).toBe(false)
    } finally {
      delete process.env.IMHUB_CLAUDE_CODE_CWD
    }
  })
})

describe('bootstrapAgentWorkspaces', () => {
  let tmpRoot: string
  let prevRoot: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'imhub-cwdtest-'))
    prevRoot = process.env.IMHUB_WORKSPACES_ROOT
    process.env.IMHUB_WORKSPACES_ROOT = tmpRoot
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.IMHUB_WORKSPACES_ROOT
    else process.env.IMHUB_WORKSPACES_ROOT = prevRoot
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('creates both built-in agent workspaces with their canonical seed files', async () => {
    const result = await bootstrapAgentWorkspaces()
    const byAgent = Object.fromEntries(result.map((r) => [r.agent, r.dir]))
    expect(byAgent['claude-code']).toBe(join(tmpRoot, 'claude-code'))
    expect(byAgent['opencode']).toBe(join(tmpRoot, 'opencode'))
    expect(await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')).toContain('Claude Code')
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toContain('OpenCode')
  })

  it('safe to run twice and does not stomp user edits', async () => {
    await bootstrapAgentWorkspaces()
    await writeFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'USER', 'utf8')
    await bootstrapAgentWorkspaces()
    expect(await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')).toBe('USER')
  })
})
