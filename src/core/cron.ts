// Minimal POSIX-flavored cron parser (5 fields: minute hour day month dow).
//
// Supported syntax per field:
//   *           wildcard
//   N           single integer
//   N,M,O       comma list
//   N-M         inclusive range
//   *\/K        step (e.g. */5 = every 5 minutes)
//   N-M/K       stepped range
//
// Day-of-week: 0 or 7 = Sunday, 1 = Monday … 6 = Saturday.
//
// nextOccurrence() returns the next Date strictly greater than `from`.
// Returns null only on bogus expressions; a valid expression always has
// a future occurrence within ~6 years (the search loop bails after that).

interface FieldSpec {
  raw: string
  values: Set<number>  // sorted ascending (Set preserves insertion order, which we control)
  min: number
  max: number
}

const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },  // 7 normalized to 0
] as const

function parseField(raw: string, min: number, max: number, fieldName: string): FieldSpec {
  const out = new Set<number>()

  for (const piece of raw.split(',')) {
    const stepMatch = piece.match(/^(.+)\/(\d+)$/)
    let body = piece
    let step = 1
    if (stepMatch) {
      body = stepMatch[1]
      step = parseInt(stepMatch[2], 10)
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid step in ${fieldName}: ${piece}`)
      }
    }

    let lo: number
    let hi: number
    if (body === '*') {
      lo = min
      hi = max
    } else {
      const range = body.match(/^(\d+)-(\d+)$/)
      if (range) {
        lo = parseInt(range[1], 10)
        hi = parseInt(range[2], 10)
      } else {
        const single = parseInt(body, 10)
        if (!Number.isFinite(single)) {
          throw new Error(`Invalid value in ${fieldName}: ${piece}`)
        }
        lo = single
        hi = single
      }
    }

    if (fieldName === 'dow') {
      if (lo === 7) lo = 0
      if (hi === 7) hi = 0
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Out-of-range value in ${fieldName}: ${piece}`)
    }

    for (let v = lo; v <= hi; v += step) out.add(v)
  }

  return { raw, values: out, min, max }
}

export interface CronSpec {
  minute: FieldSpec
  hour: FieldSpec
  day: FieldSpec
  month: FieldSpec
  dow: FieldSpec
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields (minute hour day month dow), got ${parts.length}`)
  }
  return {
    minute: parseField(parts[0], FIELD_BOUNDS[0].min, FIELD_BOUNDS[0].max, FIELD_BOUNDS[0].name),
    hour: parseField(parts[1], FIELD_BOUNDS[1].min, FIELD_BOUNDS[1].max, FIELD_BOUNDS[1].name),
    day: parseField(parts[2], FIELD_BOUNDS[2].min, FIELD_BOUNDS[2].max, FIELD_BOUNDS[2].name),
    month: parseField(parts[3], FIELD_BOUNDS[3].min, FIELD_BOUNDS[3].max, FIELD_BOUNDS[3].name),
    dow: parseField(parts[4], FIELD_BOUNDS[4].min, FIELD_BOUNDS[4].max, FIELD_BOUNDS[4].name),
  }
}

/** Next firing strictly after `from`, computed by minute-by-minute scan. */
export function nextOccurrence(spec: CronSpec, from: Date = new Date()): Date | null {
  // Start at the minute after `from` to ensure strictness.
  const cur = new Date(from)
  cur.setSeconds(0, 0)
  cur.setMinutes(cur.getMinutes() + 1)

  // Hard cap: 6 years × 366 × 24 × 60 ≈ 3.2M minutes. We bail at 8M to
  // guarantee termination on degenerate inputs (e.g. Feb 30).
  const HARD_CAP = 8_000_000
  for (let i = 0; i < HARD_CAP; i++) {
    if (matches(spec, cur)) return new Date(cur)
    cur.setMinutes(cur.getMinutes() + 1)
  }
  return null
}

function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.values.has(d.getMinutes())) return false
  if (!spec.hour.values.has(d.getHours())) return false
  if (!spec.month.values.has(d.getMonth() + 1)) return false
  // Cron quirk: when both day and dow are restricted, EITHER matches.
  const dayWild = spec.day.raw === '*'
  const dowWild = spec.dow.raw === '*'
  const dayOk = spec.day.values.has(d.getDate())
  const dowOk = spec.dow.values.has(d.getDay())
  if (dayWild && dowWild) return true
  if (!dayWild && dowWild) return dayOk
  if (dayWild && !dowWild) return dowOk
  return dayOk || dowOk
}
