#!/usr/bin/env node
/**
 * Regression test for `session_bridge_segments` limit handling.
 *
 * The shipped bug (0.8.0, reported by a user): the handler computed
 * `const limit = clampLimit(...)` but never used it —
 *   const segs = segmentsSince(events, sinceSeq)
 * — so a single call returned EVERY completed segment of the session (100+ on a
 * long session, tens of thousands of tokens), and `nextCursorSeq` was taken from
 * the last of that full list, so `sinceSeq` paging could never move forward.
 *
 * This drives the REAL registered handler (src/tools.ts) with a stub host
 * context, on both the live and the persisted (offline) path, and asserts the
 * batch size, the returned/remaining counters and that paging with the returned
 * cursor walks every segment exactly once. Runs via Node type stripping: `npm test`.
 */
import assert from 'node:assert/strict'
import { registerBridgeTools } from '../src/tools.ts'

const SEGMENT_COUNT = 120

/** One completed output segment (`assistant/message`) at the given seq. */
const seg = (seq, text = 'paragraph ' + seq) => ({
  seq,
  time: seq * 1000,
  type: 'assistant/message',
  data: { turn: Math.floor(seq / 10) + 1, step: (seq % 10) + 1, message: { content: [{ type: 'text', text }] } },
})

/** A long synthetic log: turn/start + N segments + turn/end. */
function longLog(count = SEGMENT_COUNT) {
  const events = [{ seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } }]
  for (let i = 0; i < count; i += 1) events.push(seg(i + 1))
  events.push({ seq: count + 1, time: (count + 1) * 1000, type: 'turn/end', data: { turn: 1 } })
  return events
}

/** Register every tool with a stub host; `live` selects the session source. */
function harness(events, { live = true } = {}) {
  const tools = new Map()
  const session = { header: { cwd: 'D:/code/example' }, snapshotEvents: () => events }
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [],
      get: () => undefined,
      resolveByPath: async () => undefined,
    },
    sessionPersistence: {
      open: async () => ({ header: { cwd: 'D:/code/example' }, read: async () => ({ events }), close: async () => {} }),
    },
    agents: {
      get: (id) => (live && id === 'sess' ? { id, status: 'idle', session } : undefined),
      list: () => (live ? [{ id: 'sess', status: 'idle', session }] : []),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  const favorites = { list: async () => [], has: async () => false, set: async () => ({ sessionIds: [], updatedAt: 0 }) }
  const policy = { loopGuard: false }
  registerBridgeTools({ ctx, registry, monitor, favorites, policy })
  return tools
}

/** Execute a tool and require the value to survive lossless-JSON serialization. */
async function run(tools, args) {
  const tool = tools.get('session_bridge_segments')
  const value = await tool.execute({ sessionId: 'sess', ...args }, {})
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'tool value must be lossless JSON')
  return { value, tool }
}

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

await test('segments: limit caps the batch instead of returning the whole session (main symptom)', async () => {
  const tools = harness(longLog())
  const { value } = await run(tools, { sinceSeq: 0, limit: 3 })
  assert.equal(value.segments.length, 3)
  assert.equal(value.returned, 3)
  assert.equal(value.remaining, SEGMENT_COUNT - 3)
  // 本批取 sinceSeq 之后最早的 3 段，游标落在第 3 段（不是会话末尾）。
  assert.deepEqual(value.segments.map((s) => s.seq), [1, 2, 3])
  assert.equal(value.nextCursorSeq, 3)
})

await test('segments: default limit is 10 and the hard cap is 50', async () => {
  const tools = harness(longLog())
  const { value: byDefault } = await run(tools, {})
  assert.equal(byDefault.segments.length, 10)
  const { value: capped } = await run(tools, { limit: 999 })
  assert.equal(capped.segments.length, 50)
  assert.equal(capped.remaining, SEGMENT_COUNT - 50)
})

await test('segments: paging with nextCursorSeq walks every segment exactly once', async () => {
  const tools = harness(longLog())
  const seen = []
  let cursor = 0
  for (let guard = 0; guard < 100; guard += 1) {
    const { value } = await run(tools, { sinceSeq: cursor, limit: 7 })
    if (value.segments.length === 0) break
    seen.push(...value.segments.map((s) => s.seq))
    assert.ok(value.nextCursorSeq > cursor, 'nextCursorSeq must advance past the requested cursor')
    cursor = value.nextCursorSeq
  }
  assert.equal(seen.length, SEGMENT_COUNT)
  assert.deepEqual(seen, Array.from({ length: SEGMENT_COUNT }, (_, i) => i + 1))
})

await test('segments: an empty batch echoes the cursor and reports nothing remaining', async () => {
  const tools = harness(longLog())
  const { value } = await run(tools, { sinceSeq: SEGMENT_COUNT + 1, limit: 10 })
  assert.deepEqual(value.segments, [])
  assert.equal(value.returned, 0)
  assert.equal(value.remaining, 0)
  assert.equal(value.nextCursorSeq, SEGMENT_COUNT + 1)
})

await test('segments: render advertises the remaining pages so the model keeps paging', async () => {
  const tools = harness(longLog())
  const { value, tool } = await run(tools, { limit: 3 })
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /more: 117 newer segments remain/)
  assert.match(rendered, /pass sinceSeq: 3 to page forward/)

  const { value: done, tool: toolDone } = await run(tools, { sinceSeq: SEGMENT_COUNT, limit: 10 })
  const tail = toolDone.output.render({}, done).map((block) => block.text).join('\n')
  assert.doesNotMatch(tail, /newer segments remain/)
})

await test('segments: the persisted (offline) path applies the same limit', async () => {
  const tools = harness(longLog(), { live: false })
  const { value } = await run(tools, { sinceSeq: 0, limit: 4 })
  assert.equal(value.live, false)
  assert.equal(value.segments.length, 4)
  assert.equal(value.remaining, SEGMENT_COUNT - 4)
  assert.equal(value.nextCursorSeq, 4)
})

await test('segments: an invalid limit is still rejected', async () => {
  const tools = harness(longLog())
  await assert.rejects(() => run(tools, { limit: 0 }), /invalid limit/)
  await assert.rejects(() => run(tools, { limit: 1.5 }), /invalid limit/)
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
