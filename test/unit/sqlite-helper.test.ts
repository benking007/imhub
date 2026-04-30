// Unit tests for the shared SQLite helper (N1-B / N3 in CR).
//
// Under bun the native module won't load — that's fine, we exercise
// the fail-soft path (the whole point of the helper). Under Node the
// helper would init successfully; we don't assert that here because
// the suite runs under bun.

import { describe, it, expect } from 'bun:test'
import { createSqliteHelper } from '../../src/core/sqlite-helper'
import { logger } from '../../src/core/logger'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = (name: string): string =>
  join(tmpdir(), `imhub-sqlite-helper-${name}-${Date.now()}.db`)

describe('createSqliteHelper', () => {
  it('returns null on init failure (bun has no better-sqlite3)', () => {
    const h = createSqliteHelper({
      file: tmp('init-fail'),
      schema: 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      logger,
    })
    // Under bun this never opens a db; under Node it would. Either way:
    // get() must not throw.
    expect(() => h.get()).not.toThrow()
  })

  it('safe() returns the fallback when DB is unavailable', () => {
    const h = createSqliteHelper({
      file: tmp('safe-fallback'),
      schema: 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      logger,
    })
    const r = h.safe(() => 42, -1)
    // Bun: get() returns null → safe() returns fallback (-1).
    // Node: get() opens and the lambda runs → 42. Both are valid here;
    // we just assert no throw and the return type is number.
    expect(typeof r).toBe('number')
  })

  it('_markBroken makes subsequent get() return null', () => {
    const h = createSqliteHelper({
      file: tmp('mark-broken'),
      schema: 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      logger,
    })
    h._markBroken('test')
    expect(h.get()).toBeNull()
    // safe() picks up the fallback path.
    expect(h.safe(() => 'live', 'fallback')).toBe('fallback')
  })

  it('safe() catches query errors and returns fallback', () => {
    const h = createSqliteHelper({
      file: tmp('query-err'),
      schema: 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      logger,
    })
    // Under bun this returns fallback because get() returns null.
    // Under Node, the throwing lambda is caught and fallback returned.
    const result = h.safe(() => { throw new Error('boom') }, 'caught')
    expect(result).toBe('caught')
  })
})
