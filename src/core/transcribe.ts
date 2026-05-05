// transcribe — speech-to-text with provider abstraction.
//
// Two providers ship: OpenAI Whisper API (cloud, paid, ~95%+ accuracy) and
// whisper.cpp (local binary, free, ~85-90% with medium model). Both take a
// file path, both return plain text. Provider selection is env-driven so ops
// can flip between them without code changes.
//
// Selection order (first hit wins):
//   1. IMHUB_TRANSCRIBE_PROVIDER=openai|whispercpp|none — explicit override
//   2. OPENAI_API_KEY set → openai
//   3. IMHUB_WHISPERCPP_BIN set → whispercpp
//   4. else → 'none' (callers should surface a fallback message to the user)
//
// Failures throw {@link TranscribeError} with provider + reason; the caller
// (TG adapter) catches and surfaces a "[语音转写失败：...]" marker so the
// user's interaction isn't silently dropped.

import { spawn } from 'child_process'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { randomBytes } from 'crypto'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'transcribe' })

export type TranscribeProvider = 'openai' | 'whispercpp' | 'none'

export interface TranscribeResult {
  text: string
  provider: Exclude<TranscribeProvider, 'none'>
  /** Wall-clock duration of the transcription call (ms). Useful for logging
   *  cost / latency without re-instrumenting at every call site. */
  elapsedMs: number
}

export interface TranscribeOptions {
  /** ISO 639-1 hint (e.g. 'zh', 'en'). Whisper auto-detects but a hint
   *  improves short-clip accuracy. */
  language?: string
  /** Per-call provider override (mostly for tests). */
  provider?: TranscribeProvider
}

export class TranscribeError extends Error {
  constructor(public reason: string, public provider: TranscribeProvider) {
    super(`transcribe failed (${provider}): ${reason}`)
    this.name = 'TranscribeError'
  }
}

/** Resolve which provider to use given current env. Pure / sync so callers
 *  can quickly check "is anything configured" without doing IO. */
export function detectProvider(): TranscribeProvider {
  const explicit = process.env.IMHUB_TRANSCRIBE_PROVIDER?.toLowerCase()
  if (explicit === 'openai' || explicit === 'whispercpp' || explicit === 'none') {
    return explicit
  }
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.IMHUB_WHISPERCPP_BIN) return 'whispercpp'
  return 'none'
}

/** Hard cap on a single transcription call. whisper.cpp on CPU can take
 *  multiple minutes for a long clip; we'd rather fail fast and let the user
 *  know than have grammy's update queue stall. 120 s covers a ~30 s voice
 *  clip on a 2-core VM with the base model (real-time factor ~3-4x); shorter
 *  clips finish in single-digit seconds. */
const TRANSCRIBE_TIMEOUT_MS = 120 * 1000

export async function transcribe(filePath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const provider = opts.provider ?? detectProvider()
  if (provider === 'none') {
    throw new TranscribeError(
      'no provider configured (set OPENAI_API_KEY or IMHUB_WHISPERCPP_BIN)',
      'none',
    )
  }
  const start = Date.now()
  let text: string
  if (provider === 'openai') {
    text = await transcribeWithOpenAI(filePath, opts)
  } else {
    text = await transcribeWithWhisperCpp(filePath, opts)
  }
  const elapsedMs = Date.now() - start
  log.info({ event: 'transcribe.ok', provider, elapsedMs, chars: text.length, file: basename(filePath) })
  return { text, provider, elapsedMs }
}

async function transcribeWithOpenAI(filePath: string, opts: TranscribeOptions): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new TranscribeError('OPENAI_API_KEY not set', 'openai')
  const baseURL = process.env.OPENAI_BASE_URL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'
  const model = process.env.IMHUB_OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1'

  const fileBuf = await readFile(filePath)
  const form = new FormData()
  // Blob + filename — OpenAI server uses extension to pick decoder.
  form.append('file', new Blob([new Uint8Array(fileBuf)]), basename(filePath))
  form.append('model', model)
  form.append('response_format', 'json')
  if (opts.language) form.append('language', opts.language)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal,
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new TranscribeError(`timeout (${TRANSCRIBE_TIMEOUT_MS}ms)`, 'openai')
    }
    throw new TranscribeError(`fetch failed: ${(err as Error).message}`, 'openai')
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TranscribeError(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`, 'openai')
  }
  const data = (await res.json()) as { text?: string }
  if (typeof data.text !== 'string') {
    throw new TranscribeError('response missing text field', 'openai')
  }
  return data.text.trim()
}

async function transcribeWithWhisperCpp(filePath: string, opts: TranscribeOptions): Promise<string> {
  const bin = process.env.IMHUB_WHISPERCPP_BIN
  const model = process.env.IMHUB_WHISPERCPP_MODEL
  if (!bin) throw new TranscribeError('IMHUB_WHISPERCPP_BIN not set', 'whispercpp')
  if (!model) throw new TranscribeError('IMHUB_WHISPERCPP_MODEL not set', 'whispercpp')

  // whisper.cpp's "native" multi-format support (flac/mp3/ogg) covers Vorbis
  // but NOT Opus, which is what TG voice messages use. Pre-converting to
  // 16 kHz mono PCM WAV via ffmpeg is what whisper actually wants internally
  // and works for every codec ffmpeg recognizes — strictly more reliable
  // than trusting whisper-cli's reader. Cost: one short ffmpeg invocation
  // per voice message (≈100 ms for a few-second clip).
  const wavPath = join(tmpdir(), `imhub-whisper-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath)

    // Default args target whisper.cpp's `whisper-cli` (newer build) which prints
    // the transcript to stdout when --no-prints + --no-timestamps are set.
    // Older `main` binary will need IMHUB_WHISPERCPP_ARGS overrides.
    const extraArgs = (process.env.IMHUB_WHISPERCPP_ARGS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const args = ['-m', model, '-f', wavPath, '--no-prints', '--no-timestamps', ...extraArgs]
    if (opts.language) args.push('-l', opts.language)

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        settle(() => reject(new TranscribeError(`timeout (${TRANSCRIBE_TIMEOUT_MS}ms)`, 'whispercpp')))
      }, TRANSCRIBE_TIMEOUT_MS)
      child.stdout.on('data', (b: Buffer) => stdout.push(b))
      child.stderr.on('data', (b: Buffer) => stderr.push(b))
      child.on('error', (e) => {
        clearTimeout(timer)
        settle(() => reject(new TranscribeError(`spawn failed: ${e.message}`, 'whispercpp')))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          const errText = Buffer.concat(stderr).toString().slice(0, 400)
          settle(() => reject(new TranscribeError(`exit ${code}: ${errText}`, 'whispercpp')))
          return
        }
        const text = Buffer.concat(stdout).toString().trim()
        settle(() => resolve(text))
      })
    })
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}

/**
 * Spawn ffmpeg to transcode `inputPath` to a 16 kHz mono PCM WAV at
 * `outputPath`. Hard timeout 30 s — voice clips are typically 1-30 s, so
 * this is generous. Throws TranscribeError on any non-zero exit.
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  const args = ['-y', '-loglevel', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath]
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      settle(() => reject(new TranscribeError('ffmpeg conversion timeout (30s)', 'whispercpp')))
    }, 30 * 1000)
    child.stderr.on('data', (b: Buffer) => stderr.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      settle(() => reject(new TranscribeError(`ffmpeg spawn failed: ${e.message}`, 'whispercpp')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        settle(() => resolve())
        return
      }
      const errText = Buffer.concat(stderr).toString().slice(0, 400)
      settle(() => reject(new TranscribeError(`ffmpeg exit ${code}: ${errText}`, 'whispercpp')))
    })
  })
}
