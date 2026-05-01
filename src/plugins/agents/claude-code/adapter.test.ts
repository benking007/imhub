// ClaudeCodeAdapter — verify prepareCommand picks the right path under each
// degradation condition (env disable / no IM context / bus down) and that the
// approval-routed plan writes a sensible mcp-config + cleans it up.
//
// Concurrency note: this rewrite (after we found the singleton race that
// caused mcp.json to be deleted out from under a second concurrent claude
// run) explicitly tests that two prepareCommand() calls overlapping each
// other still produce two distinct configs with no shared state.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { ApprovalBus, approvalBus } from '../../../core/approval-bus.js'
import { ClaudeCodeAdapter, _testInternals } from './index.js'
import type { SpawnPlan } from '../../../core/agent-base.js'

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

describe('ClaudeCodeAdapter prepareCommand — fallback paths', () => {
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter()
    delete process.env.IMHUB_APPROVAL_DISABLED
  })

  afterEach(() => {
    delete process.env.IMHUB_APPROVAL_DISABLED
  })

  it('falls back to dontAsk when IMHUB_APPROVAL_DISABLED=1', async () => {
    process.env.IMHUB_APPROVAL_DISABLED = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.args).not.toContain('--permission-prompt-tool')
    expect(plan.args).not.toContain('--mcp-config')
    expect(plan.cleanup).toBeUndefined()
  })

  it('falls back to dontAsk when no IM context (web/scheduler call)', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', { model: 'sonnet' })
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.cleanup).toBeUndefined()
  })

  it('falls back to dontAsk when bus is not started', async () => {
    expect(approvalBus.getSocketPath()).toBeNull()
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.cleanup).toBeUndefined()
  })
})

describe('ClaudeCodeAdapter prepareCommand — approval-routed', () => {
  let bus: ApprovalBus
  let adapter: ClaudeCodeAdapter
  let originalGetSocketPath: () => string | null
  let originalRegisterRun: typeof approvalBus.registerRun
  let originalUnregisterRun: typeof approvalBus.unregisterRun

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 500 })
    await bus.start(uniqueSocketPath())
    originalGetSocketPath = approvalBus.getSocketPath.bind(approvalBus)
    originalRegisterRun = approvalBus.registerRun.bind(approvalBus)
    originalUnregisterRun = approvalBus.unregisterRun.bind(approvalBus)
    approvalBus.getSocketPath = () => bus.getSocketPath()
    approvalBus.registerRun = bus.registerRun.bind(bus)
    approvalBus.unregisterRun = bus.unregisterRun.bind(bus)

    adapter = new ClaudeCodeAdapter()
  })

  afterEach(async () => {
    await bus.stop()
    approvalBus.getSocketPath = originalGetSocketPath
    approvalBus.registerRun = originalRegisterRun
    approvalBus.unregisterRun = originalUnregisterRun
  })

  it('writes a valid mcp-config and emits approval-mode args', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.cleanup).toBeDefined()

    const cfgIdx = plan.args.indexOf('--mcp-config')
    expect(cfgIdx).toBeGreaterThanOrEqual(0)
    const configPath = plan.args[cfgIdx + 1]
    expect(await fileExists(configPath)).toBe(true)

    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.mcpServers.imhub).toBeDefined()
    expect(parsed.mcpServers.imhub.command).toBe(process.execPath)
    expect(parsed.mcpServers.imhub.args[0]).toMatch(/mcp-approval-server\.js$/)
    expect(parsed.mcpServers.imhub.env.IMHUB_APPROVAL_SOCK).toBe(bus.getSocketPath())
    expect(typeof parsed.mcpServers.imhub.env.IMHUB_RUN_ID).toBe('string')
    expect(parsed.mcpServers.imhub.env.IMHUB_RUN_ID.length).toBeGreaterThan(0)

    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(plan.args[plan.args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__imhub__request')
    expect(plan.args[plan.args.length - 1]).toBe('hi')

    // mcp-config must come BEFORE the next `-X` flag so its variadic
    // <configs...> doesn't swallow the prompt as a second config path.
    expect(cfgIdx).toBe(0)
    expect(plan.args[cfgIdx + 2].startsWith('-')).toBe(true)

    await plan.cleanup!()
  })

  it('cleanup unregisters run and removes config tmpdir', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    const configPath = plan.args[plan.args.indexOf('--mcp-config') + 1]
    expect(await fileExists(configPath)).toBe(true)

    await plan.cleanup!()
    expect(await fileExists(configPath)).toBe(false)
  })

  it('IMHUB_APPROVAL_DISABLED still wins even when bus is up', async () => {
    process.env.IMHUB_APPROVAL_DISABLED = '1'
    try {
      const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
      expect(plan.cleanup).toBeUndefined()
      expect(plan.args).not.toContain('--mcp-config')
      expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    } finally {
      delete process.env.IMHUB_APPROVAL_DISABLED
    }
  })

  it('two prepareCommand calls return INDEPENDENT configs (concurrency safety)', async () => {
    // Fire them in parallel, with their awaits genuinely interleaving.
    const [planA, planB] = await Promise.all([
      _testInternals.prepareCommand(adapter, 'A', FULL_OPTS),
      _testInternals.prepareCommand(adapter, 'B', FULL_OPTS),
    ])

    const cfgA = planA.args[planA.args.indexOf('--mcp-config') + 1]
    const cfgB = planB.args[planB.args.indexOf('--mcp-config') + 1]
    expect(cfgA).not.toBe(cfgB)

    const rawA = JSON.parse(await readFile(cfgA, 'utf8'))
    const rawB = JSON.parse(await readFile(cfgB, 'utf8'))
    expect(rawA.mcpServers.imhub.env.IMHUB_RUN_ID)
      .not.toBe(rawB.mcpServers.imhub.env.IMHUB_RUN_ID)

    // Cleaning up A must NOT remove B's config.
    await planA.cleanup!()
    expect(await fileExists(cfgA)).toBe(false)
    expect(await fileExists(cfgB)).toBe(true)

    await planB.cleanup!()
    expect(await fileExists(cfgB)).toBe(false)
  })

  it('cleanup is idempotent (calling twice is safe)', async () => {
    const plan: SpawnPlan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    await plan.cleanup!()
    // Should not throw on the second call
    await plan.cleanup!()
  })
})
