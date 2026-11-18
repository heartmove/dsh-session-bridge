#!/usr/bin/env node
/**
 * 自动归档回归：候选过滤 + 阈值 + 调度。
 *
 * 覆盖用户口径的三条规则：
 *  - 特定天数前（严格大于；按最后活动 mtime，缺失回退 createdAt）；
 *  - 没有被收藏；
 *  - 没有被指定（autoArchiveExclude 保留名单）——另外置顶/活跃/子代理/已归档也跳过。
 *
 * 以及运行安全：默认关闭、active 拒绝只跳过、单条失败不中断、单轮上限、dispose 清理。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_ARCHIVE_INITIAL_DELAY_MS,
  AUTO_ARCHIVE_INTERVAL_MS,
  AutoArchiver,
  defaultLastActivityAt,
  selectAutoArchiveCandidates,
} from '../src/auto-archive.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 10)
const ago = (days) => NOW - days * DAY

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + (error instanceof Error ? error.message : String(error)))
  }
}

function policy(fields = {}) {
  const state = { enabled: true, days: 7, exclude: [], ...fields }
  return {
    state,
    enabled: () => state.enabled,
    days: () => state.days,
    exclude: () => new Set(state.exclude),
  }
}

function snapshot(id, { daysAgo = 30, origin, withLocation = false } = {}) {
  return {
    header: { id, createdAt: ago(daysAgo), ...(origin === undefined ? {} : { origin }) },
    ...(withLocation ? { location: { path: '/nonexistent/' + id + '.jsonl' } } : {}),
  }
}

function deps(rows, options = {}) {
  const archived = []
  const calls = []
  const registry = {
    get archivedSessionIds() { return options.archived ?? [] },
    get pinnedSessionIds() { return options.pinned ?? [] },
    async archiveSession(id) {
      calls.push(id)
      if (options.onArchive !== undefined) return options.onArchive(id)
      archived.push(id)
    },
  }
  return {
    calls,
    archived,
    value: {
      policy: options.policy ?? policy(),
      favorites: { list: async () => options.favorites ?? [] },
      persistence: { list: async () => rows },
      workspaceRegistry: registry,
      liveSessionIds: () => options.live ?? [],
      lastActivityAt: options.lastActivityAt ?? (async (row) => row.header.createdAt),
      now: () => NOW,
      log: options.log ?? (() => {}),
    },
  }
}

// ---------- 1) 阈值 ----------
await test('only sessions older than the threshold are candidates (strictly greater)', async () => {
  const rows = [snapshot('old', { daysAgo: 8 }), snapshot('exact', { daysAgo: 7 }), snapshot('fresh', { daysAgo: 1 })]
  const { value } = deps(rows)
  const selection = await selectAutoArchiveCandidates(value, NOW)
  assert.deepEqual(selection.candidates.map((c) => c.sessionId), ['old'])
  assert.equal(selection.skipped['not-old-enough'], 2)
  assert.equal(selection.scanned, 3)
})

await test('a custom day count is honoured', async () => {
  const rows = [snapshot('a', { daysAgo: 2 }), snapshot('b', { daysAgo: 5 })]
  const { value } = deps(rows, { policy: policy({ days: 1 }) })
  const selection = await selectAutoArchiveCandidates(value, NOW)
  assert.deepEqual(selection.candidates.map((c) => c.sessionId).sort(), ['a', 'b'])
})

// ---------- 2) 排除条件 ----------
await test('favorite / exclude / pinned / live / archived / subagent are all skipped', async () => {
  const rows = [
    snapshot('fav', { daysAgo: 90 }),
    snapshot('excluded', { daysAgo: 90 }),
    snapshot('pinned', { daysAgo: 90 }),
    snapshot('live', { daysAgo: 90 }),
    snapshot('archived', { daysAgo: 90 }),
    snapshot('child', { daysAgo: 90, origin: 'subagent' }),
    snapshot('gone', { daysAgo: 90 }),
  ]
  const { value } = deps(rows, {
    favorites: ['fav'],
    policy: policy({ exclude: ['excluded'] }),
    pinned: ['pinned'],
    live: ['live'],
    archived: ['archived'],
  })
  const selection = await selectAutoArchiveCandidates(value, NOW)
  assert.deepEqual(selection.candidates.map((c) => c.sessionId), ['gone'])
  assert.equal(selection.skipped.favorite, 1)
  assert.equal(selection.skipped.exclude, 1)
  assert.equal(selection.skipped.pinned, 1)
  assert.equal(selection.skipped.live, 1)
  assert.equal(selection.skipped.archived, 1)
  assert.equal(selection.skipped.subagent, 1)
})

await test('a session without a resolvable last-activity time is skipped, not archived', async () => {
  const rows = [snapshot('unknown', { daysAgo: 90 })]
  const { value } = deps(rows, { lastActivityAt: async () => undefined })
  const selection = await selectAutoArchiveCandidates(value, NOW)
  assert.deepEqual(selection.candidates, [])
  assert.equal(selection.skipped['unknown-time'], 1)
})

await test('old harness without pinnedSessionIds still works', async () => {
  const rows = [snapshot('a', { daysAgo: 30 })]
  const { value } = deps(rows)
  delete value.workspaceRegistry.pinnedSessionIds
  const selection = await selectAutoArchiveCandidates(value, NOW)
  assert.deepEqual(selection.candidates.map((c) => c.sessionId), ['a'])
})

// ---------- 3) mtime / createdAt 回退 ----------
await test('defaultLastActivityAt prefers the log mtime and falls back to createdAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-archive-'))
  try {
    const file = join(dir, 's.jsonl')
    await writeFile(file, '{}\n', 'utf8')
    const mtime = await defaultLastActivityAt({ header: { id: 's', createdAt: 1 }, location: { path: file } })
    assert.ok(typeof mtime === 'number' && mtime > 1, 'mtime must win over createdAt')

    const missing = await defaultLastActivityAt({ header: { id: 's', createdAt: 42 }, location: { path: join(dir, 'nope.jsonl') } })
    assert.equal(missing, 42, 'missing log falls back to createdAt')

    const noLocation = await defaultLastActivityAt({ header: { id: 's', createdAt: 7 } })
    assert.equal(noLocation, 7)

    const neither = await defaultLastActivityAt({ header: { id: 's' } })
    assert.equal(neither, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 4) tick ----------
await test('a disabled policy performs no scan and no archive', async () => {
  const harness = deps([snapshot('old', { daysAgo: 90 })], { policy: policy({ enabled: false }) })
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  const report = await archiver.tick()
  assert.equal(report.enabled, false)
  assert.deepEqual(report.archived, [])
  assert.equal(report.scanned, 0)
  assert.deepEqual(harness.calls, [])
})

await test('an enabled tick archives every candidate and reports the skipped counts', async () => {
  const rows = [snapshot('a', { daysAgo: 90 }), snapshot('b', { daysAgo: 8 }), snapshot('c', { daysAgo: 1 })]
  const logs = []
  const harness = deps(rows, { favorites: ['b'], log: (line) => logs.push(line) })
  const archiver = new AutoArchiver(harness.value, { log: (line) => logs.push(line) })
  const report = await archiver.tick()
  assert.deepEqual(report.archived, ['a'])
  assert.deepEqual(harness.calls, ['a'])
  assert.equal(report.skipped.favorite, 1)
  assert.equal(report.skipped['not-old-enough'], 1)
  assert.ok(logs.some((line) => line.includes('auto-archive: archived=1')), 'archiving must be logged')
})

await test('the host refusing an active session is a skip, never a hard failure', async () => {
  const rows = [snapshot('busy', { daysAgo: 90 }), snapshot('ok', { daysAgo: 90 })]
  const harness = deps(rows, {
    onArchive: async (id) => {
      if (id === 'busy') {
        const error = new Error('the session is active')
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
    },
  })
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  const report = await archiver.tick()
  assert.deepEqual(report.archived, ['ok'])
  assert.equal(report.skipped.active, 1)
  assert.deepEqual(report.failures, [])
})

await test('one unexpected archive failure does not stop the rest of the batch', async () => {
  const rows = [snapshot('bad', { daysAgo: 90 }), snapshot('good', { daysAgo: 90 })]
  const harness = deps(rows, {
    onArchive: async (id) => {
      if (id === 'bad') throw new Error('domain write failed')
    },
  })
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  const report = await archiver.tick()
  assert.deepEqual(report.archived, ['good'])
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].sessionId, 'bad')
  assert.equal(report.skipped.error, 1)
})

await test('the batch limit keeps only the oldest candidates and marks truncation', async () => {
  const rows = [
    snapshot('newest', { daysAgo: 8 }),
    snapshot('oldest', { daysAgo: 100 }),
    snapshot('middle', { daysAgo: 20 }),
  ]
  const harness = deps(rows)
  const archiver = new AutoArchiver(harness.value, { batchLimit: 2, log: () => {} })
  const report = await archiver.tick()
  assert.deepEqual(report.archived, ['oldest', 'middle'])
  assert.equal(report.truncated, true)
})

await test('a scan failure is reported instead of throwing', async () => {
  const harness = deps([])
  harness.value.persistence.list = async () => { throw new Error('persistence down') }
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  const report = await archiver.tick()
  assert.equal(report.failures.length, 1)
  assert.match(report.failures[0].message, /persistence down/)
})

await test('the policy is re-read every tick (settings changes apply without a restart)', async () => {
  const rows = [snapshot('a', { daysAgo: 3 })]
  const livePolicy = policy({ days: 7 })
  const harness = deps(rows, { policy: livePolicy })
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  assert.deepEqual((await archiver.tick()).archived, [])
  livePolicy.state.days = 1
  assert.deepEqual((await archiver.tick()).archived, ['a'])
})

await test('an overlapping tick reports busy instead of archiving twice', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const rows = [snapshot('a', { daysAgo: 90 })]
  const harness = deps(rows, { onArchive: async () => { await gate } })
  const archiver = new AutoArchiver(harness.value, { log: () => {} })
  const first = archiver.tick()
  const second = await archiver.tick()
  assert.equal(second.busy, true)
  release()
  const report = await first
  assert.deepEqual(report.archived, ['a'])
})

// ---------- 5) 调度 ----------
await test('start registers one hourly interval plus the delayed first tick, and dispose clears both', async () => {
  const intervals = []
  const timeouts = []
  const cleared = []
  const scheduler = {
    setInterval(callback, ms) { intervals.push({ callback, ms }); return { kind: 'interval' } },
    clearInterval(handle) { cleared.push(handle.kind) },
    setTimeout(callback, ms) { timeouts.push({ callback, ms }); return { kind: 'timeout' } },
    clearTimeout(handle) { cleared.push(handle.kind) },
  }
  const archiver = new AutoArchiver(deps([]).value, { log: () => {} })
  archiver.start(scheduler)
  archiver.start(scheduler)
  assert.equal(intervals.length, 1, 'start must be idempotent')
  assert.equal(intervals[0].ms, AUTO_ARCHIVE_INTERVAL_MS)
  assert.equal(timeouts[0].ms, AUTO_ARCHIVE_INITIAL_DELAY_MS)
  archiver.dispose()
  assert.deepEqual(cleared.sort(), ['interval', 'timeout'])
  archiver.dispose()
})

await test('the shipped defaults are "off" and "7 days"', async () => {
  assert.equal(AUTO_ARCHIVE_INTERVAL_MS, 3_600_000)
  assert.equal(AUTO_ARCHIVE_INITIAL_DELAY_MS, 60_000)
  const value = deps([]).value
  value.policy = policy({ enabled: false, days: 7 })
  const archiver = new AutoArchiver(value, { log: () => {} })
  const report = await archiver.tick()
  assert.equal(report.enabled, false)
  assert.equal(report.days, 7)
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)