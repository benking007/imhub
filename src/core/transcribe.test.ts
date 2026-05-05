// transcribe — focus on provider detection and the OpenAI HTTP path (with
// mocked fetch). whisper.cpp's spawn path is harder to test cleanly without
// a real binary; we lean on the type-system + manual verification for it.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_ROOT = join(tmpdir(), `imhub-transcribe-test-${process.pid}`)

const { transcribe, detectProvider, TranscribeError } = await import('./transcribe.js')

const ENV_KEYS = [
  'IMHUB_TRANSCRIBE_PROVIDER',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'IMHUB_OPENAI_TRANSCRIBE_MODEL',
  'IMHUB_WHISPERCPP_BIN',
  'IMHUB_WHISPERCPP_MODEL',
  'IMHUB_WHISPERCPP_ARGS',
]

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('transcribe — detectProvider', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })

  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('returns "none" when nothing is configured', () => {
    expect(detectProvider()).toBe('none')
  })

  it('honors explicit IMHUB_TRANSCRIBE_PROVIDER', () => {
    process.env.IMHUB_TRANSCRIBE_PROVIDER = 'openai'
    expect(detectProvider()).toBe('openai')
    process.env.IMHUB_TRANSCRIBE_PROVIDER = 'whispercpp'
    expect(detectProvider()).toBe('whispercpp')
    process.env.IMHUB_TRANSCRIBE_PROVIDER = 'none'
    expect(detectProvider()).toBe('none')
  })

  it('falls back to openai when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(detectProvider()).toBe('openai')
  })

  it('falls back to whispercpp when only the bin is set', () => {
    process.env.IMHUB_WHISPERCPP_BIN = '/usr/local/bin/whisper-cli'
    expect(detectProvider()).toBe('whispercpp')
  })

  it('explicit override wins over auto-detection', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.IMHUB_TRANSCRIBE_PROVIDER = 'whispercpp'
    expect(detectProvider()).toBe('whispercpp')
  })

  it('ignores unknown explicit value and falls through to auto-detect', () => {
    process.env.IMHUB_TRANSCRIBE_PROVIDER = 'garbage'
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(detectProvider()).toBe('openai')
  })
})

describe('transcribe — none provider raises clear error', () => {
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })
  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('throws TranscribeError with helpful message', async () => {
    await expect(transcribe('/no/such/file')).rejects.toThrow(/no provider configured/)
  })
})

describe('transcribe — openai path with mocked fetch', () => {
  let originalFetch: typeof fetch
  let saved: Record<string, string | undefined>

  beforeAll(async () => {
    await mkdir(TEST_ROOT, { recursive: true })
  })
  afterAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
    process.env.OPENAI_API_KEY = 'sk-test'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('uploads via multipart/form-data, returns trimmed text on success', async () => {
    const audioPath = join(TEST_ROOT, 'sample.ogg')
    await writeFile(audioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53]))  // 'OggS'

    let capturedReq: Request | null = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedReq = new Request(input as string, init)
      return new Response(JSON.stringify({ text: '  hello world  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await transcribe(audioPath, { language: 'zh' })
    expect(result.text).toBe('hello world')
    expect(result.provider).toBe('openai')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)

    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.url).toContain('/audio/transcriptions')
    expect(capturedReq!.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('honors OPENAI_BASE_URL for self-hosted gateways', async () => {
    const audioPath = join(TEST_ROOT, 'sample2.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'

    let capturedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = (input as Request | string).toString()
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch

    await transcribe(audioPath)
    expect(capturedUrl).toContain('gateway.example.com')
  })

  it('throws on HTTP non-2xx with status in message', async () => {
    const audioPath = join(TEST_ROOT, 'bad.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof fetch

    await expect(transcribe(audioPath)).rejects.toThrow(/HTTP 429/)
  })

  it('throws when response is missing text field', async () => {
    const audioPath = join(TEST_ROOT, 'weird.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 })) as unknown as typeof fetch

    await expect(transcribe(audioPath)).rejects.toThrow(/missing text/)
  })

  it('TranscribeError carries provider so callers can switch on it', async () => {
    const audioPath = join(TEST_ROOT, 'fail.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    try {
      await transcribe(audioPath)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(TranscribeError)
      expect((err as InstanceType<typeof TranscribeError>).provider).toBe('openai')
    }
  })
})
