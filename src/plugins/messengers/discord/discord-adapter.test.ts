// Discord adapter — offline tests.
//
// We don't dial out to discord.gg here. Instead we new the adapter, then
// inject a mock `Client` (assigning to the private field) and a mock config.
// This exercises every code path *except* `client.login()`, which is exactly
// what we want — login is already covered by discord.js's own tests.
//
// Two slices:
//   1. Adapter contract — sendMessage routes via channels.fetch().send(),
//      messageCreate forwards the right MessageContext, whitelist filtering
//      and bot self-message filtering both work.
//   2. End-to-end with the real ApprovalBus + approval-router. Sidecar pokes
//      bus → bus calls notifier → notifier hits DiscordAdapter.sendMessage →
//      mock channel records the prompt → user "replies" by emitting a fake
//      messageCreate → cli.ts's interception path resolves the pending. We
//      verify the sidecar receives `{behavior: "allow"}`.
//
// All tests use mock objects shaped just enough for the adapter; the public
// discord.js types stay external.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { EventEmitter } from 'events'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { Socket, createConnection } from 'net'
import { DiscordAdapter } from './discord-adapter.js'
import {
  approvalBus,
  type RunContext,
} from '../../../core/approval-bus.js'
import {
  install as installApprovalRouter,
  uninstall as uninstallApprovalRouter,
  tryHandleApprovalReply,
  platformToMessengerName,
} from '../../../core/approval-router.js'
import type { MessengerAdapter, MessageContext } from '../../../core/types.js'

// ChannelType.GuildText = 0; DM = 1 (verified against discord-api-types/v10)
const TYPE_GUILD_TEXT = 0

interface FakeChannel {
  id: string
  type: number
  send: (text: string) => Promise<{ id: string }>
  sendTyping: () => Promise<void>
  sent: string[]
  isTextBased: () => boolean
}

function makeFakeChannel(id: string, type = TYPE_GUILD_TEXT): FakeChannel {
  const sent: string[] = []
  return {
    id,
    type,
    sent,
    send: async (text: string) => { sent.push(text); return { id: `msg-${sent.length}` } },
    sendTyping: async () => {},
    isTextBased: () => true,
  }
}

interface FakeClient extends EventEmitter {
  channels: { fetch: (id: string) => Promise<FakeChannel | null> }
  destroy: () => void
}

function makeFakeClient(channels: Map<string, FakeChannel>): FakeClient {
  const ee = new EventEmitter() as FakeClient
  ee.channels = {
    fetch: async (id: string) => channels.get(id) ?? null,
  }
  ee.destroy = () => {}
  return ee
}

/**
 * Bootstrap a DiscordAdapter without going through start(). Sets the private
 * `client` and `config` so the adapter behaves as if logged in.
 */
function bootAdapter(opts: {
  channels: Map<string, FakeChannel>
  config?: Partial<{ allowedGuilds: string[]; allowedChannels: string[]; channelId: string }>
}): { adapter: DiscordAdapter; client: FakeClient; received: MessageContext[] } {
  const adapter = new DiscordAdapter()
  const client = makeFakeClient(opts.channels)
  // Private-field injection — keeps test off the discord.js network path.
  ;(adapter as unknown as { client: FakeClient }).client = client
  ;(adapter as unknown as { config: object }).config = {
    botToken: 'fake',
    channelId: opts.config?.channelId ?? 'default',
    allowedGuilds: opts.config?.allowedGuilds,
    allowedChannels: opts.config?.allowedChannels,
  }
  ;(adapter as unknown as { isRunning: boolean }).isRunning = true

  // Hook the same event the real start() does.
  client.on('messageCreate', async (m) => {
    await (adapter as unknown as {
      handleDiscordMessage: (m: unknown) => Promise<void>
    }).handleDiscordMessage(m)
  })

  const received: MessageContext[] = []
  adapter.onMessage(async (ctx) => { received.push(ctx) })
  return { adapter, client, received }
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-discord-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

describe('DiscordAdapter — sendMessage', () => {
  it('writes the message to the channel resolved by channels.fetch', async () => {
    const ch = makeFakeChannel('chan-1')
    const { adapter } = bootAdapter({ channels: new Map([['chan-1', ch]]) })

    await adapter.sendMessage('chan-1', 'hello world')

    expect(ch.sent.length).toBe(1)
    expect(ch.sent[0]).toBe('hello world')
  })

  it('passes text through markdownToDiscord (heading → bold)', async () => {
    const ch = makeFakeChannel('chan-1')
    const { adapter } = bootAdapter({ channels: new Map([['chan-1', ch]]) })

    await adapter.sendMessage('chan-1', '# Title\nbody')

    expect(ch.sent.length).toBe(1)
    // # Title becomes **Title** so Discord renders it as bold rather than '#'.
    expect(ch.sent[0]).toContain('**Title**')
    expect(ch.sent[0]).not.toMatch(/^#\s/m)
  })

  it('throws when channel is not resolvable', async () => {
    const { adapter } = bootAdapter({ channels: new Map() })
    await expect(adapter.sendMessage('missing', 'x')).rejects.toThrow(/not found|not text-based/)
  })

  it('splits into multiple sends when message exceeds 2000 chars', async () => {
    const ch = makeFakeChannel('chan-1')
    const { adapter } = bootAdapter({ channels: new Map([['chan-1', ch]]) })

    const big = 'x'.repeat(4500)
    await adapter.sendMessage('chan-1', big)

    expect(ch.sent.length).toBeGreaterThanOrEqual(2)
    for (const chunk of ch.sent) expect(chunk.length).toBeLessThanOrEqual(2000)
  })
})

describe('DiscordAdapter — incoming messageCreate', () => {
  it('forwards a MessageContext with platform="discord" and threadId=channelId', async () => {
    const ch = makeFakeChannel('chan-1')
    const { client, received } = bootAdapter({ channels: new Map([['chan-1', ch]]) })

    client.emit('messageCreate', {
      id: 'm-1',
      channelId: 'chan-1',
      guildId: 'g-1',
      content: 'hello',
      author: { id: 'u-1', bot: false },
      createdAt: new Date(),
      attachments: { size: 0 },
    })

    // give the async handler a tick
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(1)
    expect(received[0].platform).toBe('discord')
    expect(received[0].message.threadId).toBe('chan-1')
    expect(received[0].message.userId).toBe('u-1')
    expect(received[0].message.text).toBe('hello')
  })

  it('drops messages from bot accounts (incl. self)', async () => {
    const { client, received } = bootAdapter({ channels: new Map() })
    client.emit('messageCreate', {
      id: 'm-bot',
      channelId: 'chan-1',
      guildId: 'g-1',
      content: 'I am a bot',
      author: { id: 'b-1', bot: true },
      createdAt: new Date(),
      attachments: { size: 0 },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
  })

  it('drops messages from non-whitelisted guilds when allowedGuilds set', async () => {
    const { client, received } = bootAdapter({
      channels: new Map(),
      config: { allowedGuilds: ['g-allowed'] },
    })
    client.emit('messageCreate', {
      id: 'm-x',
      channelId: 'chan-1',
      guildId: 'g-blocked',
      content: 'hi',
      author: { id: 'u-1', bot: false },
      createdAt: new Date(),
      attachments: { size: 0 },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
  })

  it('drops messages from non-whitelisted channels when allowedChannels set', async () => {
    const { client, received } = bootAdapter({
      channels: new Map(),
      config: { allowedChannels: ['chan-allowed'] },
    })
    client.emit('messageCreate', {
      id: 'm-x',
      channelId: 'chan-blocked',
      guildId: 'g-1',
      content: 'hi',
      author: { id: 'u-1', bot: false },
      createdAt: new Date(),
      attachments: { size: 0 },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
  })

  it('drops empty messages with no attachments', async () => {
    const { client, received } = bootAdapter({ channels: new Map() })
    client.emit('messageCreate', {
      id: 'm-empty',
      channelId: 'chan-1',
      guildId: 'g-1',
      content: '',
      author: { id: 'u-1', bot: false },
      createdAt: new Date(),
      attachments: { size: 0 },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
  })
})

describe('platformToMessengerName + DiscordAdapter — name match', () => {
  it('platform "discord" resolves to messenger name "discord"', () => {
    const adapter = new DiscordAdapter()
    expect(adapter.name).toBe('discord')
    expect(platformToMessengerName('discord')).toBe('discord')
  })
})

describe('Discord × ApprovalBus × approval-router — end-to-end (offline)', () => {
  let socketPath: string

  beforeEach(() => {
    socketPath = uniqueSocketPath()
  })

  afterEach(async () => {
    try { uninstallApprovalRouter() } catch {}
    try { await approvalBus.stop() } catch {}
  })

  it('Discord user → approval prompt sent to Discord channel → reply "y" → sidecar gets allow', async () => {
    // 1. Boot DiscordAdapter with mocked client + channel
    const ch = makeFakeChannel('chan-discord-1')
    const { adapter, client } = bootAdapter({
      channels: new Map([['chan-discord-1', ch]]),
    })

    // 2. Wire approval-bus + router so platform=discord resolves to this adapter
    await approvalBus.start(socketPath)
    const ctx: RunContext = {
      threadId: 'chan-discord-1',
      platform: 'discord',
      userId: 'u-1',
      channelId: 'default',
    }
    approvalBus.registerRun('run-discord-1', ctx)
    installApprovalRouter({
      resolveMessenger: (platform) => {
        const name = platformToMessengerName(platform)
        return name === 'discord' ? (adapter as unknown as MessengerAdapter) : undefined
      },
    })

    // Subscribe to messages from the adapter just to prove the cli wiring path
    // (cli.ts:181) would receive the user's reply too.
    let messageHandlerCalled = 0
    adapter.onMessage(async () => { messageHandlerCalled++ })

    // 3. Sidecar end: dial the unix socket and send a fake approval request
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')

    const decisions: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) decisions.push(JSON.parse(line))
      }
    })

    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-discord-1', reqId: 'rd-1',
      toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'tu-1',
    }) + '\n')

    // 4. Wait for the prompt to land in the Discord channel
    for (let i = 0; i < 50 && ch.sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(ch.sent.length).toBe(1)
    expect(ch.sent[0]).toContain('Bash')
    expect(ch.sent[0]).toContain('git status')
    expect(ch.sent[0]).toContain('y') // y/n hint line

    // 5. User "replies" via Discord. In production cli.ts:181 calls
    //    tryHandleApprovalReply BEFORE handleMessage. We replicate that order:
    //    emit messageCreate (which the adapter delivers to onMessage), and
    //    then call tryHandleApprovalReply directly to mirror cli.ts.
    client.emit('messageCreate', {
      id: 'm-reply',
      channelId: 'chan-discord-1',
      guildId: 'g-1',
      content: 'y',
      author: { id: 'u-1', bot: false },
      createdAt: new Date(),
      attachments: { size: 0 },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(messageHandlerCalled).toBeGreaterThanOrEqual(1)

    const consumed = tryHandleApprovalReply('chan-discord-1', 'y')
    expect(consumed).toBe(true)

    // 6. Sidecar should now receive {behavior: "allow"}
    for (let i = 0; i < 50 && decisions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(decisions.length).toBe(1)
    expect((decisions[0] as { behavior: string }).behavior).toBe('allow')

    sock.end()
  })

  it('Discord user replies "n" → sidecar gets deny', async () => {
    const ch = makeFakeChannel('chan-discord-2')
    const { adapter } = bootAdapter({
      channels: new Map([['chan-discord-2', ch]]),
    })
    await approvalBus.start(socketPath)
    approvalBus.registerRun('run-discord-2', {
      threadId: 'chan-discord-2', platform: 'discord', userId: 'u-1', channelId: 'default',
    })
    installApprovalRouter({
      resolveMessenger: () => adapter as unknown as MessengerAdapter,
    })

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    const decisions: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) decisions.push(JSON.parse(line))
      }
    })

    sock.write(JSON.stringify({
      v: 1, type: 'approval', runId: 'run-discord-2', reqId: 'rd-2',
      toolName: 'Write', input: { file_path: '/etc/passwd' }, toolUseId: 'tu-2',
    }) + '\n')

    for (let i = 0; i < 50 && ch.sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(ch.sent.length).toBe(1)

    expect(tryHandleApprovalReply('chan-discord-2', 'n')).toBe(true)

    for (let i = 0; i < 50 && decisions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(decisions.length).toBe(1)
    const d = decisions[0] as { behavior: string; message?: string }
    expect(d.behavior).toBe('deny')

    sock.end()
  })
})
