#!/usr/bin/env node
/**
 * Regression tests for the self-send guard in `session_bridge_send`.
 *
 * The shipped bug (0.9.0): the handler trusted `sessionId` without comparing it
 * to the host-provided caller. A session that called the bridge with its own id
 * queued its own message back into itself, creating a feedback loop. The guard
 * must reject BEFORE live-agent lookup, followup/steer, workspace accounting,
 * registry.touch and waitForReply.
 *
 * Compatibility boundary: when the host does not supply `exec.agent`, the
 * caller cannot be proven to be the target, so the old send behaviour is kept
 * instead of guessing an identity. That case is pinned below.
 *
 * This drives the REAL registered handler (src/tools.ts) with a stub host
 * context, so it covers the actual execute() path. Runs via Node type
 * stripping: `npm test`.
 */
import assert from 'node:assert/strict'
import { registerBridgeTools } from '../src/tools.ts'

const SELF_SEND_ERROR = 'session_bridge_send refuses self-send: caller and target are both "sb-caller". Choose a different target session.'

/** Build a minimal live-agent stub that records every delivery attempt. */
function makeAgent(id, calls) {
  return {
    id,
    status: 'idle',
    ctx: {},
    session: {
      header: {},
      snapshotEvents: () => [],
    },
    followup(message) {
      calls.followups.push({ id, message })
    },
    steer(message) {
      calls.steers.push({ id, message })
    },
    cancel() {},
  }
}

/** Register every bridge tool against a stub host with the given live targets. */
function harness(targetIds = []) {
  const tools = new Map()
  const calls = { followups: [], steers: [], lookups: [], touches: [] }
  const agents = new Map(targetIds.map((id) => [id, makeAgent(id, calls)]))
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    agents: {
      get(id) {
        calls.lookups.push(id)
        return agents.get(id)
      },
      list: () => [...agents.values()],
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [],
      get: () => undefined,
      resolveByPath: async () => undefined,
    },
    sessionPersistence: { open: async () => { throw new Error('not used') } },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = {
    all: async () => [],
    record() {},
    touch(sessionId, entry) { calls.touches.push({ sessionId, entry }) },
    load: async () => {},
    persist: async () => {},
  }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  registerBridgeTools({ ctx, registry, monitor })

  return {
    calls,
    agents,
    async run(args, caller) {
      const exec = {
        ...(caller === undefined ? {} : { agent: caller }),
        signal: new AbortController().signal,
      }
      return tools.get('session_bridge_send').execute(args, exec)
    },
  }
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

await test('self-send: same caller and target is rejected before any delivery', async () => {
  const h = harness(['sb-caller'])
  const caller = h.agents.get('sb-caller')

  await assert.rejects(
    () => h.run({ sessionId: 'sb-caller', message: 'echo' }, caller),
    (error) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, SELF_SEND_ERROR)
      return true
    },
  )

  assert.equal(h.calls.followups.length, 0, 'self-send must not call followup')
  assert.equal(h.calls.steers.length, 0, 'self-send must not call steer')
  assert.equal(h.calls.touches.length, 0, 'self-send must not touch the registry')
  assert.deepEqual(h.calls.lookups, [], 'self-send must reject before live-agent lookup')
})

await test('self-send: steer mode is rejected just like queue mode', async () => {
  const h = harness(['sb-caller'])
  const caller = h.agents.get('sb-caller')

  await assert.rejects(
    () => h.run({ sessionId: 'sb-caller', message: 'interrupt me', mode: 'steer' }, caller),
    (error) => error instanceof Error && error.message === SELF_SEND_ERROR,
  )

  assert.equal(h.calls.followups.length, 0)
  assert.equal(h.calls.steers.length, 0, 'steer-mode self-send must not call steer')
  assert.equal(h.calls.touches.length, 0)
  assert.deepEqual(h.calls.lookups, [])
})

await test('cross-send: a different caller delivers exactly once to the target', async () => {
  const h = harness(['sb-caller', 'sb-target'])
  const caller = h.agents.get('sb-caller')
  const target = h.agents.get('sb-target')

  const value = await h.run({ sessionId: 'sb-target', message: 'hello' }, caller)

  assert.equal(value.accepted, true)
  assert.equal(value.sessionId, 'sb-target')
  assert.equal(value.sinceSeq, -1, 'the send contract still returns the pre-send anchor')
  assert.equal(h.calls.followups.length, 1, 'target followup runs exactly once')
  assert.equal(h.calls.followups[0].id, 'sb-target')
  assert.equal(h.calls.followups[0].message.role, 'user')
  assert.deepEqual(h.calls.followups[0].message.content, [{ type: 'text', text: 'hello' }])
  assert.equal(h.calls.steers.length, 0)
  assert.deepEqual(h.calls.touches.map((t) => t.sessionId), ['sb-target'])
  assert.deepEqual(h.calls.lookups, ['sb-target'])
})

await test('compat: a missing caller keeps the old send behaviour', async () => {
  const h = harness(['sb-target'])
  const target = h.agents.get('sb-target')

  const value = await h.run({ sessionId: 'sb-target', message: 'hello' })

  assert.equal(value.accepted, true)
  assert.equal(value.sessionId, 'sb-target')
  assert.equal(h.calls.followups.length, 1, 'without a caller the send path stays compatible')
  assert.equal(h.calls.followups[0].id, 'sb-target')
  assert.equal(h.calls.followups[0].message.role, 'user')
  assert.deepEqual(h.calls.followups[0].message.content, [{ type: 'text', text: 'hello' }])
  assert.equal(h.calls.steers.length, 0)
  assert.deepEqual(h.calls.touches.map((t) => t.sessionId), ['sb-target'])
  assert.deepEqual(h.calls.lookups, ['sb-target'])
  assert.ok(target !== undefined, 'the target stub must exist for the compatibility case')
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exitCode = 1
