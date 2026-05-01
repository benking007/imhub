// bgjob-reader tests — work entirely against temp dirs we lay out to mimic
// the real wrapper's on-disk layout. We never touch ~/.claude or
// ~/.config/opencode and never spawn the wrapper.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveRoots,
  listJobsForRoot,
  getJobDetail,
  listAllJobs,
  findRoot,
  type BgjobRoot,
} from './bgjob-reader.js'

let tmp: string
const ORIGINAL_ENV = process.env.IMHUB_BGJOB_ROOTS

async function writeJob(root: string, id: string, meta: Record<string, unknown>, log?: string): Promise<void> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
  if (log !== undefined) await writeFile(join(dir, 'log.txt'), log)
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'bgjob-reader-test-'))
})

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env.IMHUB_BGJOB_ROOTS
  else process.env.IMHUB_BGJOB_ROOTS = ORIGINAL_ENV
  await rm(tmp, { recursive: true, force: true })
})

describe('resolveRoots', () => {
  it('returns defaults when env unset', () => {
    delete process.env.IMHUB_BGJOB_ROOTS
    const roots = resolveRoots()
    expect(roots.length).toBe(2)
    expect(roots.map((r) => r.id).sort()).toEqual(['claude', 'opencode'])
  })

  it('parses comma-separated absolute paths from env, with id= prefix', () => {
    process.env.IMHUB_BGJOB_ROOTS = `c=${tmp}/a,o=${tmp}/b`
    const roots = resolveRoots()
    expect(roots.map((r) => r.id)).toEqual(['c', 'o'])
    expect(roots[0].path).toBe(join(tmp, 'a'))
  })

  it('falls back to default when env contains no valid entries', () => {
    process.env.IMHUB_BGJOB_ROOTS = 'relative/path'
    const roots = resolveRoots()
    expect(roots.length).toBe(2) // back to defaults
  })

  it('uses basename as id when no id= prefix', () => {
    process.env.IMHUB_BGJOB_ROOTS = `${tmp}/myroot`
    const roots = resolveRoots()
    expect(roots[0].id).toBe('myroot')
  })
})

describe('listJobsForRoot', () => {
  it('reads jobs from index.json + each meta.json', async () => {
    await writeFile(join(tmp, 'index.json'), JSON.stringify({
      jobs: [
        { id: 'j1', name: 'task-a', started_at: '2026-05-01T10:00:00+08:00' },
        { id: 'j2', name: 'task-b', started_at: '2026-05-01T11:00:00+08:00' },
      ],
    }))
    await writeJob(tmp, 'j1', {
      id: 'j1', name: 'task-a', status: 'completed', pid: 100,
      started_at: '2026-05-01T10:00:00+08:00',
      ended_at: '2026-05-01T10:05:00+08:00',
      exit_code: 0,
    })
    await writeJob(tmp, 'j2', {
      id: 'j2', name: 'task-b', status: 'running', pid: 200,
      started_at: '2026-05-01T11:00:00+08:00',
      ended_at: null, exit_code: null,
    })

    const root: BgjobRoot = { id: 'test', path: tmp, label: 'test' }
    const jobs = await listJobsForRoot(root)
    expect(jobs.length).toBe(2)
    // newest-first
    expect(jobs[0].id).toBe('j2')
    expect(jobs[0].status).toBe('running')
    expect(jobs[1].status).toBe('completed')
    expect(jobs[1].exit_code).toBe(0)
    expect(jobs.every((j) => j.rootId === 'test')).toBe(true)
  })

  it('falls back to directory scan when index.json is missing', async () => {
    await writeJob(tmp, '20260501-jobx-abcd', {
      id: '20260501-jobx-abcd', name: 'jobx', status: 'failed',
      pid: null, started_at: '2026-05-01T09:00:00+08:00',
      ended_at: '2026-05-01T09:01:00+08:00', exit_code: 1,
    })
    const root: BgjobRoot = { id: 'test', path: tmp, label: 'test' }
    const jobs = await listJobsForRoot(root)
    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe('20260501-jobx-abcd')
    expect(jobs[0].status).toBe('failed')
  })

  it('returns [] when root does not exist', async () => {
    const root: BgjobRoot = { id: 'nope', path: join(tmp, 'does-not-exist'), label: 'x' }
    const jobs = await listJobsForRoot(root)
    expect(jobs).toEqual([])
  })

  it('skips jobs whose meta.json is missing or unparseable', async () => {
    await writeFile(join(tmp, 'index.json'), JSON.stringify({
      jobs: [{ id: 'good' }, { id: 'broken' }, { id: 'missing' }],
    }))
    await writeJob(tmp, 'good', { id: 'good', name: 'g', status: 'running' })
    await mkdir(join(tmp, 'broken'), { recursive: true })
    await writeFile(join(tmp, 'broken', 'meta.json'), '{not json')

    const root: BgjobRoot = { id: 't', path: tmp, label: 't' }
    const jobs = await listJobsForRoot(root)
    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe('good')
  })

  it('rejects path-traversal IDs from a malformed index.json', async () => {
    await writeFile(join(tmp, 'index.json'), JSON.stringify({
      jobs: [{ id: '../../etc/passwd' }, { id: 'real' }],
    }))
    await writeJob(tmp, 'real', { id: 'real', name: 'r', status: 'running' })
    const jobs = await listJobsForRoot({ id: 't', path: tmp, label: 't' })
    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe('real')
  })
})

describe('getJobDetail', () => {
  it('returns full meta + log tail', async () => {
    await writeJob(tmp, 'j1', {
      id: 'j1', name: 'task-a', status: 'completed',
      cmd: ['/usr/bin/python3', '-m', 'foo'],
      workdir: '/tmp/work',
      out_dir: '/tmp/work/out',
      pid: 100, exit_code: 0,
      started_at: '2026-05-01T10:00:00+08:00',
      ended_at: '2026-05-01T10:05:00+08:00',
      restart_generation: 2,
      resources: { cpu_time: 1.5, rss_kb: 8192, state: 'S' },
    }, 'line1\nline2\nline3\nline4\n')

    const detail = await getJobDetail({ id: 't', path: tmp, label: 't' }, 'j1', 2)
    expect(detail).not.toBeNull()
    expect(detail!.cmd).toEqual(['/usr/bin/python3', '-m', 'foo'])
    expect(detail!.workdir).toBe('/tmp/work')
    expect(detail!.restart_generation).toBe(2)
    expect(detail!.log_tail).toBe('line3\nline4')
    expect(detail!.resources?.rss_kb).toBe(8192)
  })

  it('returns null when log file is missing', async () => {
    await writeJob(tmp, 'j1', { id: 'j1', name: 'x', status: 'running' })
    const detail = await getJobDetail({ id: 't', path: tmp, label: 't' }, 'j1')
    expect(detail).not.toBeNull()
    expect(detail!.log_tail).toBeNull()
  })

  it('returns null for unknown id', async () => {
    const detail = await getJobDetail({ id: 't', path: tmp, label: 't' }, 'no-such')
    expect(detail).toBeNull()
  })

  it('rejects path-traversal id without reading anything', async () => {
    const detail = await getJobDetail({ id: 't', path: tmp, label: 't' }, '../etc')
    expect(detail).toBeNull()
  })
})

describe('listAllJobs + findRoot', () => {
  it('groups jobs by root with isolation between roots', async () => {
    const a = join(tmp, 'a'); const b = join(tmp, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await writeJob(a, 'jA', { id: 'jA', name: 'a-only', status: 'running' })
    await writeJob(b, 'jB', { id: 'jB', name: 'b-only', status: 'completed' })
    process.env.IMHUB_BGJOB_ROOTS = `aa=${a},bb=${b}`

    const all = await listAllJobs()
    expect(all.length).toBe(2)
    const byId = Object.fromEntries(all.map((g) => [g.root.id, g.jobs]))
    expect(byId['aa'].length).toBe(1)
    expect(byId['aa'][0].id).toBe('jA')
    expect(byId['bb'][0].id).toBe('jB')
  })

  it('findRoot returns null for unknown id', () => {
    process.env.IMHUB_BGJOB_ROOTS = `aa=${tmp}`
    expect(findRoot('aa')?.path).toBe(tmp)
    expect(findRoot('zz')).toBeNull()
  })
})
