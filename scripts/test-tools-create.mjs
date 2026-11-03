#!/usr/bin/env node
/**
 * Regression tests for `session_bridge_create` (src/tools.ts + src/session-create.ts).
 *
 * The create path was refactored into a shared `createBridgeSession()` because the
 * watchdog's loop transfer must create its successor session EXACTLY the same way
 * the tool does (target cwd resolution → model inheritance → agents.create + setup
 * → workspace accounting → registry record → optional first prompt + anchor). A
 * silent divergence there would produce successor sessions missing a field or with
 * the wrong accounting, so the tool's contract is pinned here against a stub host.
 *
 * Drives the real registered handler via Node type stripping: `npm test`.
 */
import assert from 'node:assert/strict'
import { registerBridgeTools } from '../src/tools.ts'
import { installModelSelectionCompat } from '../src/session-create.ts'

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

function tolerantCtx() {
  const target = {}
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop === 'then') return undefined
      if (!(prop in obj)) obj[prop] = () => undefined
      return obj[prop]
    },
  })
}

const WS = { id: 'ws-1', path: 'D:/ws-one', sessionIds: [] }

function harness(options = {}) {
  const registered = new Map()
  const events = []
  const createCalls = []
  const records = []
  const touches = []
  const composed = []
  const mounted = []
  const followups = []
  const attached = []

  const agent = {
    id: 'sb-stub',
    status: 'running',
    options: {},
    ctx: tolerantCtx(),
    session: {
      header: { cwd: options.callerCwd ?? 'D:/caller' },
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' } }),
    },
    followup(message) {
      followups.push(message)
      // Simulate the model answering the first prompt: the tool's wait must see a
      // NEW event after the baseline it captured before the prompt was sent.
      events.push({ seq: events.length, time: Date.now(), type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'pong' }] } } })
    },
  }

  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    agents: {
      get: () => undefined,
      list: () => [],
      create: async (createOptions) => {
        createCalls.push(createOptions)
        if (typeof createOptions.setup === 'function') await createOptions.setup(tolerantCtx())
        return { agent }
      },
    },
    workspaceRegistry: {
      get: (id) => (id === WS.id ? WS : undefined),
      list: () => [WS],
      resolveByPath: async (cwd) => (cwd === WS.path
        ? { id: WS.id, path: WS.path, attachSession: async (sessionId) => { attached.push(sessionId) } }
        : undefined),
    },
    agentPresets: {
      composeFrom: (_agentCtx, parentCtx) => { composed.push(parentCtx); return 'composed' },
      mount: async (_agentCtx, id) => { mounted.push(id) },
    },
    sessionPersistence: { open: async () => { throw new Error('not used') } },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = {
    record(entry) { records.push(entry) },
    touch(id) { touches.push(id) },
    all: async () => [],
    load: async () => {},
    persist: async () => {},
  }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  registerBridgeTools({ ctx, registry, monitor })
  return {
    tools: registered, agent, events, createCalls, records, touches, composed, mounted, followups, attached,
    async run(args, withCaller = false) {
      const exec = {
        ...(withCaller ? { agent: { ctx: tolerantCtx(), session: agent.session } } : {}),
        signal: new AbortController().signal,
      }
      return registered.get('session_bridge_create').execute(args, exec)
    },
  }
}

// --- creation contract ---------------------------------------------------------
await test('create: cwd target, first prompt, anchor and registry record', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', prompt: '做 X', title: '任务会话' })
  assert.match(created.sessionId, /^sb-/)
  assert.equal(created.cwd, 'D:/target')
  assert.equal(created.title, '任务会话')
  // The anchor is the maxSeq captured BEFORE the prompt; a brand-new session has an
  // empty log, so maxSeq is -1 — the same "count every event from the start" sentinel
  // session_bridge_wait documents.
  assert.equal(created.sinceSeq, -1)
  assert.equal(created.reply, undefined, 'waitForReply defaults to false')

  assert.equal(h.createCalls.length, 1)
  assert.equal(h.createCalls[0].sessionId, created.sessionId)
  assert.equal(h.createCalls[0].meta.cwd, 'D:/target')
  assert.deepEqual(h.createCalls[0].meta.agentPreset, undefined)
  assert.equal(h.followups.length, 1, 'first prompt delivered once')
  assert.deepEqual(h.followups[0].content, [{ type: 'text', text: '做 X' }])
  assert.deepEqual(h.touches, [created.sessionId])
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0].sessionId, created.sessionId)
  assert.equal(h.records[0].source, 'create')
  assert.equal(h.records[0].title, '任务会话')
  assert.equal(h.records[0].cwd, 'D:/target')
})

await test('create: no prompt means no followup, no anchor and no touch', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target' })
  assert.equal(h.followups.length, 0)
  assert.equal(h.touches.length, 0)
  assert.equal(created.sinceSeq, undefined, 'nothing was sent, so there is no anchor')
  assert.equal(JSON.parse(JSON.stringify(created)).sinceSeq, undefined)
})

await test('create: an empty prompt is treated as no prompt', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', prompt: '   ' })
  assert.equal(h.followups.length, 0)
  assert.equal(created.sinceSeq, undefined)
})

await test('create: workspace accounting follows the resolved cwd', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/ws-one' })
  assert.equal(created.workspaceId, 'ws-1')
  assert.deepEqual(h.attached, [created.sessionId], 'session attached to its workspace')
  assert.equal(h.records[0].workspaceId, 'ws-1')
})

await test('create: workspaceId resolves to the workspace path', async () => {
  const h = harness()
  const created = await h.run({ workspaceId: 'ws-1' })
  assert.equal(created.cwd, 'D:/ws-one')
  assert.equal(created.workspaceId, 'ws-1')
})

await test('create: an unknown workspaceId is rejected before creating anything', async () => {
  const h = harness()
  await assert.rejects(() => h.run({ workspaceId: 'nope' }), /workspace not found: nope/)
  assert.equal(h.createCalls.length, 0)
})

await test('create: with no target and no caller cwd it refuses to guess', async () => {
  const h = harness()
  await assert.rejects(() => h.run({}), /cannot determine target working directory/)
  assert.equal(h.createCalls.length, 0)
})

// --- model / preset inheritance ------------------------------------------------
await test('create: model selection is inherited from the caller conversation', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target' }, true)
  assert.deepEqual(h.createCalls[0].agentOptions, { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' })
  assert.equal(h.composed.length, 1, 'caller presets are composed when no explicit preset is requested')
  assert.deepEqual(h.mounted, [])
})

await test('create: explicit model overrides beat the caller conversation', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target', provider: 'p2', model: 'm2', reasoningEffort: 'low' }, true)
  assert.deepEqual(h.createCalls[0].agentOptions, { provider: 'p2', model: 'm2', reasoningEffort: 'low' })
})

await test('create: an explicit agentPreset is mounted instead of joining the caller', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target', agentPreset: 'reviewer' }, true)
  assert.equal(h.createCalls[0].meta.agentPreset, 'reviewer')
  assert.deepEqual(h.mounted, ['reviewer'])
  assert.equal(h.composed.length, 0, 'an explicit preset must not also join the caller composition')
})

await test('create: without a caller nothing is inherited and no preset is mounted', async () => {
  const h = harness()
  await h.run({ cwd: 'D:/target' })
  assert.deepEqual(h.createCalls[0].agentOptions, {})
  assert.equal(h.composed.length, 0)
  assert.equal(h.mounted.length, 0)
})

// --- waitForReply --------------------------------------------------------------
await test('create: waitForReply returns the first reply instead of an anchor', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', prompt: '做 X', waitForReply: true, timeoutMs: 5000 })
  assert.equal(created.reply.message.text, 'pong')
  assert.equal(created.reply.timedOut, false)
  assert.equal(created.sinceSeq, undefined, 'a returned reply replaces the anchor')
})

await test('create: waitForReply without a prompt neither waits nor returns an anchor', async () => {
  const h = harness()
  const created = await h.run({ cwd: 'D:/target', waitForReply: true, timeoutMs: 1 })
  assert.equal(created.reply, undefined)
  assert.equal(created.sinceSeq, undefined)
})

// --- host-signature compat: installModelSelection (0.2.2-alpha.3 breaking change) ---
// Upstream changed `installModelSelection(agentCtx, selection)` (<= 0.2.1-rc.x) into
// `installModelSelection(agentCtx)` (>= 0.2.2-alpha.3): the selection moved to
// AgentModel + the durable `modelSelection` projection, and the installer now only
// attaches the model-switch notice listener. Passing the old second argument is
// silently ignored, so the plugin MUST branch on arity instead of trusting that the
// extra argument still does something — otherwise a caller-inherited route quietly
// stops being applied on the old hosts (and the intent disappears on the new ones).
await test('compat: the two-argument installer receives the caller selection', async () => {
  const calls = []
  const selection = { current: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }
  const install = function (agentCtx, sel) { calls.push([agentCtx, sel]) }
  const ctx = { id: 'agent-ctx' }
  assert.equal(installModelSelectionCompat(install, ctx, selection), true)
  assert.deepEqual(calls, [[ctx, selection]])
})

await test('compat: the one-argument installer is called without the selection', async () => {
  const calls = []
  const selection = { current: { provider: 'p1', model: 'm1' } }
  // Arity 1 is exactly the 0.2.2-alpha.3 shape.
  const install = function (agentCtx) { calls.push(agentCtx) }
  const ctx = { id: 'agent-ctx' }
  assert.equal(installModelSelectionCompat(install, ctx, selection), true)
  assert.deepEqual(calls, [ctx])
  assert.equal(install.length, 1, 'the control case must really be arity 1')
})

await test('compat: a throwing installer reports false so the caller can fall back', async () => {
  const original = console.warn
  const warned = []
  console.warn = (...args) => { warned.push(args.join(' ')) }
  try {
    const install = function (agentCtx) { throw new Error('no such service') }
    assert.equal(installModelSelectionCompat(install, {}, { current: undefined }), false)
    assert.match(warned.at(-1) ?? '', /installModelSelection failed/)
  } finally {
    console.warn = original
  }
})

await test('compat: an absent installer reports false', async () => {
  assert.equal(installModelSelectionCompat(undefined, {}, { current: undefined }), false)
})

// Characterizes the host the plugin is BUILT against: if upstream ever restores a
// two-argument installer, this assertion is the reminder to re-read both paths.
await test('compat: the installed dsh-agent installer signature is understood', async () => {
  const agentApi = await import('@deepseek-ai/dsh-agent')
  const install = agentApi.installModelSelection
  assert.equal(typeof install, 'function', 'dsh-agent must export installModelSelection')
  assert.ok([1, 2].includes(install.length), 'installer arity must be 1 (>=0.2.2-alpha.3) or 2 (<=0.2.1-rc.x), got ' + String(install.length))
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
