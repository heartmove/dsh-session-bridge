#!/usr/bin/env node
/**
 * Regression test for `session_bridge_archived` (resolveTitles path).
 *
 * The shipped bug: the handler resolved titles with `item.title = titleOf(...)`,
 * which writes an OWN `title: undefined` property for every archived session
 * whose log has no `session/title` event and no user message. The host rejects
 * such a tool value ("value is not lossless JSON"), so `resolveTitles: true`
 * failed for the WHOLE tool call whenever the archive set contained one such
 * session — even though the ids themselves were fine.
 *
 * This drives the REAL registered handler (src/tools.ts) with a stub host
 * context, so the assertion covers the actual execute() path rather than a
 * re-implementation. Runs via Node type stripping: `npm test`.
 */
import assert from 'node:assert/strict'
import { registerBridgeTools } from '../src/tools.ts'

/** Capture every tool the plugin registers. */
function captureTools() {
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    workspaceRegistry: {
      // 'no-title'    → log exists but carries no title event / user message
      // 'gone'        → persistence open() throws (log missing)
      // 'titled'      → title event present
      // 'user-only'   → no title event, but a first user message
      // 'empty-title' → title event is an empty string
      archivedSessionIds: ['titled', 'user-only', 'no-title', 'gone', 'empty-title'],
      list: () => [],
      get: () => undefined,
      resolveByPath: async () => undefined,
    },
    sessionPersistence: {
      open: async (id) => {
        if (id === 'gone') throw new Error('session "gone" not found')
        return {
          header: {},
          read: async () => ({
            events: id === 'no-title'
              ? [{ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } }]
              : id === 'titled'
                ? [{ seq: 1, time: 1, type: 'session/title', data: { title: 'Named session' } }]
                : id === 'empty-title'
                  ? [{ seq: 1, time: 1, type: 'session/title', data: { title: '' } }]
                  : [{ seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first prompt' }] } }],
          }),
          close: async () => {},
        }
      },
    },
    agents: { get: () => undefined, list: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  registerBridgeTools({ ctx, registry, monitor })
  return tools
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

const tools = captureTools()

await test('registerBridgeTools registers the archived tool', () => {
  assert.ok(tools.has('session_bridge_archived'))
  assert.ok(tools.has('session_bridge_archive'))
  assert.ok(tools.has('session_bridge_unarchive'))
  assert.equal(tools.size, 15)
})

/**
 * A registry stub that behaves like the real one for the archive verbs: without
 * `stopActivity` an active session refuses the archive, and the archive set is
 * mutable so unarchive can be observed. Records every call for assertions.
 */
function archiveHarness(initial = []) {
  const archive = [...initial]
  const calls = []
  const registered = new Map()
  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    workspaceRegistry: {
      get archivedSessionIds() { return archive },
      async archiveSession(id, options) {
        calls.push({ verb: 'archive', id, options })
        if (options?.stopActivity !== true) throw new Error('the session is active (turn)')
        archive.push(id)
      },
      async unarchiveSession(id) {
        calls.push({ verb: 'unarchive', id })
        const at = archive.indexOf(id)
        if (at !== -1) archive.splice(at, 1)
      },
      list: () => [],
      get: () => undefined,
      resolveByPath: async () => undefined,
    },
    sessionPersistence: { open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }) },
    agents: { get: () => undefined, list: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  registerBridgeTools({ ctx, registry, monitor })
  return { registered, calls, archive }
}

await test('archive: an active session is refused with a stopActivity hint', async () => {
  const h = archiveHarness()
  await assert.rejects(
    () => h.registered.get('session_bridge_archive').execute({ sessionId: 'busy' }, {}),
    (error) => error instanceof Error && error.message.includes('the session is active') && error.message.includes('stopActivity: true'),
  )
  assert.deepEqual(h.calls, [{ verb: 'archive', id: 'busy', options: undefined }])
  assert.deepEqual(h.archive, [])
})

await test('archive: stopActivity passes through and archives the active session', async () => {
  const h = archiveHarness(['old'])
  const value = await h.registered.get('session_bridge_archive').execute({ sessionId: 'busy', stopActivity: true }, {})
  assert.deepEqual(h.calls, [{ verb: 'archive', id: 'busy', options: { stopActivity: true } }])
  assert.deepEqual(h.archive, ['old', 'busy'])
  assert.equal(value.stopActivity, true)
  assert.deepEqual(value.archivedSessionIds, ['old', 'busy'])
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

await test('unarchive: drops the id and returns the remaining archive set', async () => {
  const h = archiveHarness(['a', 'b'])
  const value = await h.registered.get('session_bridge_unarchive').execute({ sessionId: 'a' }, {})
  assert.deepEqual(h.calls, [{ verb: 'unarchive', id: 'a' }])
  assert.deepEqual(h.archive, ['b'])
  assert.deepEqual(value.archivedSessionIds, ['b'])
  assert.equal(value.totalArchived, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

await test('unarchive: a not-archived id is an idempotent no-op', async () => {
  const h = archiveHarness(['a'])
  const value = await h.registered.get('session_bridge_unarchive').execute({ sessionId: 'missing' }, {})
  assert.deepEqual(h.archive, ['a'])
  assert.deepEqual(value.archivedSessionIds, ['a'])
})

await test('unarchive: an empty sessionId is rejected before touching the registry', async () => {
  const h = archiveHarness(['a'])
  await assert.rejects(
    () => h.registered.get('session_bridge_unarchive').execute({ sessionId: '   ' }, {}),
    (error) => error instanceof Error && error.message.includes('invalid sessionId'),
  )
  assert.deepEqual(h.calls, [])
})

await test('resolveTitles: unresolved titles stay absent — the value is lossless JSON', async () => {
  const tool = tools.get('session_bridge_archived')
  const value = await tool.execute({ resolveTitles: true }, {})
  // The whole point of the fix: the host serializes the tool value, so any own
  // `undefined` property makes the call fail. An unroundtrippable value must not happen.
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  assert.equal(value.items.length, 5)
  const byId = new Map(value.items.map((item) => [item.sessionId, item]))
  assert.equal(byId.get('titled').title, 'Named session')
  assert.equal(byId.get('user-only').title, 'first prompt')
  assert.equal(Object.hasOwn(byId.get('no-title'), 'title'), false)
  assert.equal(Object.hasOwn(byId.get('gone'), 'title'), false)
  assert.equal(Object.hasOwn(byId.get('empty-title'), 'title'), false)
})

await test('resolveTitles: bridge-registered aliases win over log titles', async () => {
  const tools2 = new Map()
  const ctx = {
    tools: { register: (tool) => { tools2.set(tool.name, tool) } },
    workspaceRegistry: { archivedSessionIds: ['sb-1'], list: () => [], get: () => undefined, resolveByPath: async () => undefined },
    sessionPersistence: {
      open: async () => ({
        header: {},
        read: async () => ({ events: [{ seq: 1, time: 1, type: 'session/title', data: { title: 'log title' } }] }),
        close: async () => {},
      }),
    },
    agents: { get: () => undefined, list: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [{ sessionId: 'sb-1', title: 'alias title' }], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  registerBridgeTools({ ctx, registry, monitor: { dispose() {}, start() {}, stop: () => false, list: () => [] } })
  const value = await tools2.get('session_bridge_archived').execute({ resolveTitles: true }, {})
  assert.equal(value.items[0].title, 'alias title')
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

await test('without resolveTitles: ids only, always lossless', async () => {
  const tool = tools.get('session_bridge_archived')
  const value = await tool.execute({}, {})
  assert.equal(value.total, 5)
  assert.equal(value.returned, 5)
  assert.deepEqual(value.items, [
    { sessionId: 'titled' }, { sessionId: 'user-only' }, { sessionId: 'no-title' }, { sessionId: 'gone' }, { sessionId: 'empty-title' },
  ])
})

// 归档集合会无限增长（真实宿主里已有 200+ id）。整集合回显会把真正的结果埋进
// 数千 token 的 id 列表，所以 archive/unarchive 只回显最近的一段 + 准确总数。
await test('archive render: the archive set is summarized, not echoed in full', async () => {
  const many = Array.from({ length: 26 }, (_, i) => 's' + String(i))
  const h = archiveHarness(many)
  const tool = h.registered.get('session_bridge_archive')
  const value = await tool.execute({ sessionId: 'new', stopActivity: true }, {})
  assert.equal(value.archivedSessionIds.length, 27)
  assert.equal(value.totalArchived, 27)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /^archived new \(stopped running work\)\ntotal archived: 27\n/)
  assert.match(text, /\+7 earlier omitted/)
  assert.ok(text.includes('new'))
  assert.ok(text.includes('s25'))
  assert.ok(!text.includes('s6,'))
})

await test('unarchive render: same summary, and the removed id is gone', async () => {
  const many = Array.from({ length: 26 }, (_, i) => 's' + String(i))
  const h = archiveHarness(many)
  const tool = h.registered.get('session_bridge_unarchive')
  const value = await tool.execute({ sessionId: 's25' }, {})
  assert.equal(value.totalArchived, 25)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /^unarchived s25\ntotal archived: 25\n/)
  assert.ok(!text.includes('s25,'))
})

await test('archived: limit returns the newest ids and keeps the real total', async () => {
  const tool = tools.get('session_bridge_archived')
  const value = await tool.execute({ limit: 2 }, {})
  assert.deepEqual(value.items.map((i) => i.sessionId), ['gone', 'empty-title'])
  assert.equal(value.returned, 2)
  assert.equal(value.total, 5)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  const text = tool.output.render({ limit: 2 }, value)[0].text
  assert.match(text, /^5 archived; newest 2:\n/)
})

await test('archived: an invalid limit is rejected before reading the registry', async () => {
  const tool = tools.get('session_bridge_archived')
  await assert.rejects(() => tool.execute({ limit: 0 }, {}), /invalid limit/)
})

await test('resolveTitles: only the returned ids are read from persistence', async () => {
  let opens = 0
  const registered = new Map()
  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    workspaceRegistry: {
      archivedSessionIds: ['a', 'b', 'c', 'd'],
      list: () => [],
      get: () => undefined,
      resolveByPath: async () => undefined,
    },
    sessionPersistence: {
      open: async () => {
        opens += 1
        return {
          header: {},
          read: async () => ({ events: [{ seq: 1, time: 1, type: 'session/title', data: { title: 'from log' } }] }),
          close: async () => {},
        }
      },
    },
    agents: { get: () => undefined, list: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  registerBridgeTools({ ctx, registry, monitor: { dispose() {}, start() {}, stop: () => false, list: () => [] } })
  const value = await registered.get('session_bridge_archived').execute({ resolveTitles: true, limit: 2 }, {})
  assert.equal(opens, 2)
  assert.deepEqual(value.items.map((i) => i.sessionId), ['c', 'd'])
  assert.equal(value.items[0].title, 'from log')
  assert.equal(value.total, 4)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
