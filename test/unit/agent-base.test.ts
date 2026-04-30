// Unit tests for AgentBase streaming pipeline using a real `node` subprocess
// as the synthetic CLI. Verifies:
//   - JSONL events stream through extractText() as chunks (not buffered)
//   - non-JSON lines pass through verbatim
//   - error JSONL events do NOT leak into chunk output
//   - non-zero exit + handleError surfaces friendly text
//   - abort signal terminates the stream early
//   - multi-byte UTF-8 boundary is preserved across chunks

import { describe, it, expect } from 'bun:test'
import { AgentBase } from '../../src/core/agent-base'

// Fake adapter that runs `node -e <script>` so we control stdout exactly.
class ScriptAgent extends AgentBase {
  readonly name: string
  readonly aliases: string[] = []
  protected get commandName(): string { return 'node' }

  constructor(name: string, private readonly script: string, private readonly perAgentTimeoutMs?: number) {
    super()
    this.name = name
  }

  protected buildArgs(_prompt: string): string[] {
    return ['-e', this.script]
  }

  protected extractText(event: unknown): string {
    const e = event as Record<string, unknown>
    if (e && typeof e === 'object' && e.type === 'text' && typeof e.content === 'string') {
      return e.content
    }
    return ''
  }

  protected get timeoutMs(): number {
    return this.perAgentTimeoutMs ?? super.timeoutMs
  }

  protected handleError(code: number, _stderr: string, errorMessage: string): string | null {
    if (errorMessage.includes('quota')) return `❌ ${this.name} quota exceeded (exit ${code})`
    return null
  }
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('AgentBase streaming', () => {
  it('streams JSONL events as separate chunks', async () => {
    const script = `
      const events = [
        { type: 'text', content: 'hello' },
        { type: 'text', content: ' world' },
      ];
      for (const e of events) {
        process.stdout.write(JSON.stringify(e) + '\\n');
      }
    `
    const agent = new ScriptAgent('script-stream', script)
    const chunks = await collect(agent['spawnStream']('prompt'))
    expect(chunks).toContain('hello')
    expect(chunks).toContain(' world')
    expect(chunks.join('')).toBe('hello world')
  })

  it('passes non-JSON lines through verbatim', async () => {
    const script = `process.stdout.write('plain text line\\n');`
    const agent = new ScriptAgent('script-plain', script)
    const chunks = await collect(agent['spawnStream']('p'))
    expect(chunks.join('')).toContain('plain text line')
  })

  it('does not leak error event content into chunk output', async () => {
    const script = `
      process.stdout.write(JSON.stringify({ type: 'error', error: 'boom' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text', content: 'after' }) + '\\n');
    `
    const agent = new ScriptAgent('script-err', script)
    const chunks = await collect(agent['spawnStream']('p'))
    expect(chunks.join('')).not.toContain('boom')
    expect(chunks.join('')).toContain('after')
  })

  it('surfaces friendly error via handleError on non-zero exit', async () => {
    const script = `
      process.stdout.write(JSON.stringify({ type: 'error', error: 'quota exceeded' }) + '\\n');
      process.exit(2);
    `
    const agent = new ScriptAgent('script-quota', script)
    const chunks = await collect(agent['spawnStream']('p'))
    expect(chunks.join('')).toContain('quota exceeded')
  })

  it('falls back to generic exit-code message when handleError returns null', async () => {
    const script = `process.exit(7);`
    const agent = new ScriptAgent('script-fail', script)
    const chunks = await collect(agent['spawnStream']('p'))
    expect(chunks.join('')).toContain('exit 7')
  })

  it('honors AbortSignal mid-stream', async () => {
    const script = `
      process.stdout.write(JSON.stringify({ type: 'text', content: 'first' }) + '\\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: 'text', content: 'second' }) + '\\n');
      }, 1000);
      // Hold the process open
      setTimeout(() => process.exit(0), 5000);
    `
    const agent = new ScriptAgent('script-abort', script)
    const ac = new AbortController()
    const gen = agent['spawnStream']('p', ac.signal)

    // Wait for first chunk
    const first = await gen.next()
    expect(first.value).toBe('first')

    // Abort and drain
    ac.abort()
    let tail = ''
    for await (const chunk of gen) tail += chunk
    expect(tail).toContain('🚫')
  })

  it('triggers timeout when stream exceeds budget', async () => {
    const script = `setTimeout(() => process.exit(0), 5000);`
    // 50ms timeout to force the timeout branch quickly
    const agent = new ScriptAgent('script-timeout', script, 50)
    const chunks = await collect(agent['spawnStream']('p'))
    expect(chunks.join('')).toContain('⚠️')
    expect(chunks.join('')).toContain('超时')
  })

  it('preserves multi-byte UTF-8 across chunk boundaries', async () => {
    // Write a long Chinese string as one event but flushed in pieces by Node.
    // The LineBuffer + StringDecoder must avoid U+FFFD replacement at chunk
    // edges. We use repeated CJK to maximize chance of a boundary fall in
    // the middle of a 3-byte codepoint.
    const script = `
      const s = '中文测试'.repeat(2000);
      const e = JSON.stringify({ type: 'text', content: s });
      process.stdout.write(e + '\\n');
    `
    const agent = new ScriptAgent('script-utf8', script)
    const chunks = await collect(agent['spawnStream']('p'))
    const joined = chunks.join('')
    expect(joined).not.toContain('�')
    expect(joined.length).toBeGreaterThan(2000)
  })

  it('spawnAndCollect returns the concatenated stream', async () => {
    const script = `
      process.stdout.write(JSON.stringify({ type: 'text', content: 'a' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text', content: 'b' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text', content: 'c' }) + '\\n');
    `
    const agent = new ScriptAgent('script-collect', script)
    const result = await agent.spawnAndCollect('p')
    expect(result).toBe('abc')
  })
})
