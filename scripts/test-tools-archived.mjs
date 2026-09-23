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
  assert.equal(tools.size, 14)
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
  assert.deepEqual(value.items, [
    { sessionId: 'titled' }, { sessionId: 'user-only' }, { sessionId: 'no-title' }, { sessionId: 'gone' }, { sessionId: 'empty-title' },
  ])
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
