#!/usr/bin/env node
/**
 * Smoke test for the BUILT bundle (lib/index.js).
 *
 * `check:compat` proves src/ type-checks and that lib/index.js inlined the same
 * DSH version as the installed harness — but neither proves the artifact LOADS.
 * The bundle is a self-contained ESM module that inlines every @deepseek-ai/*
 * import, so an upstream rename or a broken inline shows up only when the host
 * mounts it. This mounts the built bundle against a stub host context and
 * asserts the full contributed tool set registers, then drives the
 * archive/unarchive handlers through the artifact itself.
 *
 * Runs AFTER `pnpm build` (the artifact must exist). Node type stripping is not
 * needed: the bundle is plain ESM JavaScript.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.js')

const mod = await import(pathToFileURL(BUNDLE).href)

const tools = new Map()
const archive = []
const calls = []
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool) } },
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
  },
  sessionPersistence: { open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }) },
  agents: { get: () => undefined, list: () => [] },
  setInterval: () => 0,
  clearInterval: () => {},
  effect: () => {},
}

assert.equal(typeof mod.apply, 'function', 'lib/index.js must export apply()')
mod.apply(ctx)
// BridgeRegistry.load() is fired without await; give it a tick so a failure surfaces here.
await new Promise((done) => setTimeout(done, 50))

const expected = [
  'session_bridge_create', 'session_bridge_send', 'session_bridge_resume', 'session_bridge_wait',
  'session_bridge_segments', 'session_bridge_read', 'session_bridge_find', 'session_bridge_status',
  'session_bridge_cancel', 'session_bridge_monitor_start', 'session_bridge_monitor_stop',
  'session_bridge_monitor_list', 'session_bridge_archive', 'session_bridge_unarchive',
  'session_bridge_archived',
]
assert.deepEqual([...tools.keys()].sort(), [...expected].sort(), 'registered tool set')

await assert.rejects(
  () => tools.get('session_bridge_archive').execute({ sessionId: 'busy' }, {}),
  (error) => error.message.includes('stopActivity: true'),
)
const archived = await tools.get('session_bridge_archive').execute({ sessionId: 'busy', stopActivity: true }, {})
assert.deepEqual(calls.at(-1), { verb: 'archive', id: 'busy', options: { stopActivity: true } })
assert.deepEqual(archived.archivedSessionIds, ['busy'])
assert.deepEqual(JSON.parse(JSON.stringify(archived)), archived)

const unarchived = await tools.get('session_bridge_unarchive').execute({ sessionId: 'busy' }, {})
assert.deepEqual(unarchived.archivedSessionIds, [])
assert.equal(unarchived.totalArchived, 0)
assert.deepEqual(JSON.parse(JSON.stringify(unarchived)), unarchived)

// The archive set grows without bound (the author's own profile holds 200+ ids),
// so the artifact must summarize the set instead of echoing every id, and
// session_bridge_archived must window it. Both are artifact-level contracts:
// src/ tests cannot catch a bundle that shipped before the fix.
const many = Array.from({ length: 25 }, (_, i) => 's' + String(i))
archive.push(...many)
const big = await tools.get('session_bridge_archive').execute({ sessionId: 'busy2', stopActivity: true }, {})
assert.equal(big.totalArchived, 26)
const bigText = tools.get('session_bridge_archive').output.render({}, big).map((block) => block.text).join('\n')
assert.match(bigText, /total archived: 26/)
assert.match(bigText, /\+6 earlier omitted/)
assert.ok(bigText.includes('busy2'))
assert.ok(!bigText.includes('s4,'))

assert.ok(
  JSON.stringify(tools.get('session_bridge_archived').parameters ?? {}).includes('limit'),
  'session_bridge_archived must declare the limit parameter',
)
const windowed = await tools.get('session_bridge_archived').execute({ limit: 2 }, {})
assert.equal(windowed.total, 26)
assert.deepEqual(windowed.items.map((item) => item.sessionId), ['s24', 'busy2'])
assert.deepEqual(JSON.parse(JSON.stringify(windowed)), windowed)

// The artifact must not ship a stale DSH copy (the 0.3.3 regression).
assert.ok(!readFileSync(BUNDLE, 'utf8').includes('0.1.7-alpha'), 'lib/index.js must not inline alpha DSH code')

console.log('smoke-bundle: OK — lib/index.js mounts and registers ' + String(tools.size) + ' tools')
