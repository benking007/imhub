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

/**
 * Smallest value in `values` that is ≥ target, or null if none.
 * The set is iterated linearly; sizes are tiny (≤ 60) so the cost is
 * negligible vs the surrounding work.
 */
function ceilingIn(values: Set<number>, target: number): number | null {
  let best: number | null = null
  for (const v of values) {
    if (v >= target && (best === null || v < best)) best = v
  }
  return best
}

function firstIn(values: Set<number>): number {
  let best = Infinity
  for (const v of values) if (v < best) best = v
  return best
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dayWild = spec.day.raw === '*'
  const dowWild = spec.dow.raw === '*'
  const dayOk = spec.day.values.has(d.getDate())
  const dowOk = spec.dow.values.has(d.getDay())
  if (dayWild && dowWild) return true
  if (!dayWild && dowWild) return dayOk
  if (dayWild && !dowWild) return dowOk
  return dayOk || dowOk
}

/**
 * Next firing strictly after `from`, found by field-level
 * fast-forwarding. For "yearly at midnight Jan 1" (`0 0 1 1 *`) this
 * converges in at most 4-5 jumps, vs ~525_000 minute increments under
 * the previous brute-force loop.
 *
 * The loop walks fields outermost (month) → innermost (minute). On a
 * mismatch we set the field to its ceiling (next valid value) and reset
 * everything inside it. If no ceiling exists in the current scope we
 * step one unit up in the parent field. JavaScript Date handles
 * carries (month=12 → next year, hour=24 → next day) natively.
 */
export function nextOccurrence(spec: CronSpec, from: Date = new Date()): Date | null {
  const cur = new Date(from)
  cur.setSeconds(0, 0)
  cur.setMinutes(cur.getMinutes() + 1)

  // Sane upper bound: 1000 field jumps will resolve any 5-field spec —
  // crontab can't repeat itself within that many adjustments.
  for (let i = 0; i < 1000; i++) {
    // 1) Month
    const mthIdx = cur.getMonth() + 1  // 1-indexed
    const mthCeil = ceilingIn(spec.month.values, mthIdx)
    if (mthCeil === null) {
      // No matching month this year — roll to next year's first valid month.
      cur.setFullYear(cur.getFullYear() + 1, firstIn(spec.month.values) - 1, 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    if (mthCeil !== mthIdx) {
      cur.setMonth(mthCeil - 1, 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }

    // 2) Day (handle the day-OR-dow quirk through dayMatches)
    if (!dayMatches(spec, cur)) {
      cur.setDate(cur.getDate() + 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }

    // 3) Hour
    const hr = cur.getHours()
    const hrCeil = ceilingIn(spec.hour.values, hr)
    if (hrCeil === null) {
      cur.setDate(cur.getDate() + 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    if (hrCeil !== hr) {
      cur.setHours(hrCeil, 0, 0, 0)
      continue
    }

    // 4) Minute
    const mn = cur.getMinutes()
    const mnCeil = ceilingIn(spec.minute.values, mn)
    if (mnCeil === null) {
      cur.setHours(cur.getHours() + 1, 0, 0, 0)
      continue
    }
    if (mnCeil !== mn) {
      cur.setMinutes(mnCeil, 0, 0)
      continue
    }

    // All four fields are valid simultaneously — done.
    return new Date(cur)
  }
  return null
}
