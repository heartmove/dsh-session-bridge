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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.js')

// 收藏与桥登记表都落在 DSH home 下。冒烟测试不能污染真实 ~/.dsh，所以在 import
// 产物（它会 inline dsh-home-paths）之前把 DSH_HOME 指到临时目录。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
process.env.DSH_HOME = HOME
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const mod = await import(pathToFileURL(BUNDLE).href)

const tools = new Map()
const archive = []
const calls = []
const routes = []
const timers = { intervals: [], timeouts: [], cleared: [] }
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool) } },
  workspaceRegistry: {
    get archivedSessionIds() { return archive },
    get pinnedSessionIds() { return [] },
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
  sessionPersistence: {
    open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }),
    list: async () => [],
  },
  agents: { get: () => undefined, list: () => [] },
  // 可选服务注入：只有 webServer 存在时收藏路由才会挂上。
  inject: (names, callback) => {
    const child = { effect: (fn) => fn() }
    if (names.includes('webServer')) {
      child.webServer = { register: (route) => { routes.push(route); return () => {} } }
    }
    callback(child)
  },
  setInterval: (callback, ms) => { timers.intervals.push(ms); return 0 },
  clearInterval: () => { timers.cleared.push('interval') },
  setTimeout: (callback, ms) => { timers.timeouts.push(ms); return 0 },
  clearTimeout: () => { timers.cleared.push('timeout') },
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
  'session_bridge_archived', 'session_bridge_favorite',
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

// --- chain-of-thought loop guard (0.6.0) -------------------------------------
// Two artifact-level contracts that src/ tests cannot prove: (1) the bundle that
// actually runs was REBUILT with the guard, and (2) the new knobs are exposed on
// the tool the host reads. The stub host above deliberately has no
// agents.roots()/isOwnedBy() — the guard must degrade gracefully there, which is
// also the case for older harnesses.
const monitorTool = tools.get('session_bridge_monitor_start')
const monitorParams = JSON.stringify(monitorTool.parameters ?? {})
for (const name of [
  'loopGuard', 'loopField', 'loopMinCycles', 'loopMinRepeats', 'loopMinConfidence', 'loopMinHits',
  'loopCooldownMs', 'loopMaxTransfers', 'loopTransfer', 'loopAutoMonitor', 'loopDescendants',
  'loopHandoffPrompt', 'loopTransferDepth',
]) {
  assert.ok(monitorParams.includes(name), 'session_bridge_monitor_start must declare ' + name)
}
assert.ok(String(monitorTool.description).includes('chain-of-thought LOOPS'), 'the tool description advertises loop detection')
const bundleText = readFileSync(BUNDLE, 'utf8')
for (const marker of ['chain-of-thought loop detected', 'LOOP-TRANSFER', 'LOOP-SUBAGENT-CANCEL', 'transfer budget exhausted', '仍在运行的子代理']) {
  assert.ok(bundleText.includes(marker), 'the rebuilt bundle must inline the loop guard: ' + marker)
}

const started = await monitorTool.execute({ sessionId: 'loop-target', loopDescendants: 'report', loopMaxTransfers: 2 }, {})
assert.equal(started.monitor.config.loopDescendants, 'report')
assert.equal(started.monitor.config.loopMaxTransfers, 2)
const monitorText = tools.get('session_bridge_monitor_list').output.render({}, await tools.get('session_bridge_monitor_list').execute({}, {})).map((block) => block.text).join('\n')
assert.ok(monitorText.includes('loopGuard: on'), 'monitor_list renders the loop guard line')
assert.ok(monitorText.includes('descendants=report'))
assert.equal(await tools.get('session_bridge_monitor_stop').execute({ sessionId: 'loop-target' }, {}).then((value) => value.wasActive), true)

// --- plugin switch + /cot-loop command (0.7.0) --------------------------------
// Two artifact-level contracts: (1) the bundle exports the volatile Config that
// the Plugins settings form renders (dsh-settings only shows volatile fields),
// and (2) the /cot-loop slash command is registered against a host command
// surface, sharing that same config.
assert.ok(mod.Config !== undefined, 'lib/index.js must export Config (the settings form reads it)')
const configJson = mod.Config.toJSON()
const configRoot = configJson.refs?.[String(configJson.uid)] ?? configJson
const configFields = Object.keys(configRoot.dict ?? {})
assert.ok(configFields.includes('loopGuard'), 'Config must expose loopGuard (the settings switch)')
for (const field of configFields) {
  const node = configJson.refs?.[String(configRoot.dict[field])] ?? configRoot.dict[field]
  assert.equal(node.meta?.volatile, true, 'Config.' + field + ' must be volatile so dsh-settings renders it')
}

const commands = []
const switchEdits = []
const tools2 = new Map()
const ctx2 = {
  ...ctx,
  tools: { register: (tool) => { tools2.set(tool.name, tool) } },
  inject: (names, callback) => {
    const child = {}
    if (names.includes('commands')) child.commands = { register: (definition) => { commands.push(definition) } }
    if (names.includes('configEditor')) {
      child.configEditor = {
        entries: () => [{ options: { id: 'dsh-session-bridge' } }],
        edit: async (entry, change) => { switchEdits.push(change({}, {})) },
      }
    }
    callback(child)
  },
}
// ctx2 打开自动归档：收藏功能只在它开启时可用，收藏工具的成功路径在这里跑。
mod.apply(ctx2, { loopGuard: false, autoArchive: true })
await new Promise((done) => setTimeout(done, 50))

assert.equal(commands.length, 1, 'apply() must register the /cot-loop command when the host has a command surface')
assert.equal(commands[0].name, 'cot-loop')
assert.ok(String(commands[0].input?.hint ?? '').includes('off'), 'the command advertises its input')
const switchStatus = await commands[0].handler({ rawInput: 'status' })
assert.equal(switchStatus.kind, 'success')
assert.ok(switchStatus.text.includes('关闭'), 'status must report the configured switch state (off)')
assert.ok(switchStatus.text.includes('loopGuard'), 'status must name the settings field')

const switchOn = await commands[0].handler({ rawInput: 'on' })
assert.equal(switchOn.kind, 'success')
assert.deepEqual(switchEdits.at(-1), { loopGuard: true }, 'the command writes loopGuard into the plugin config')
assert.ok(switchOn.text.includes('已写入插件配置'), 'a persisted switch says so')

// The disabled plugin switch must show up on the monitor surface (and, in the
// guard itself, short-circuit loop detection for every monitor).
const switchStarted = await tools2.get('session_bridge_monitor_start').execute({ sessionId: 'switch-target' }, {})
assert.equal(switchStarted.monitor.config.sessionId, 'switch-target')
const switchText = tools2.get('session_bridge_monitor_list').output
  .render({}, await tools2.get('session_bridge_monitor_list').execute({}, {}))
  .map((block) => block.text).join('\n')
assert.ok(switchText.includes('plugin switch'), 'monitor_list shows the plugin-level switch is off')

const bundleWithSwitch = readFileSync(BUNDLE, 'utf8')
for (const marker of ['cot-loop', '思维链循环自动中断', 'volatile']) {
  assert.ok(bundleWithSwitch.includes(marker), 'the rebuilt bundle must inline the switch wiring: ' + marker)
}

// --- favorites + hourly auto-archive (0.9.0) ---------------------------------
// Artifact-level contracts the src/ tests cannot prove: the shipped bundle really
// registers the favorite tool, mounts the favorites HTTP route the Client half
// calls, and schedules the hourly auto-archive batch.
assert.ok(configFields.includes('autoArchive'), 'Config must expose autoArchive (the settings switch)')
assert.ok(configFields.includes('autoArchiveDays'), 'Config must expose autoArchiveDays')
assert.ok(configFields.includes('autoArchiveExclude'), 'Config must expose autoArchiveExclude')

const favoriteTool = tools.get('session_bridge_favorite')
const favoriteParams = JSON.stringify(favoriteTool.parameters ?? {})
for (const name of ['sessionId', 'favorite', 'list', 'resolveTitles']) {
  assert.ok(favoriteParams.includes(name), 'session_bridge_favorite must declare ' + name)
}
assert.match(String(favoriteTool.description), /NOT workspace pinning/, 'the tool must state favorites are not pins')

// 默认配置（autoArchive=false）下收藏功能整体下线：工具必须明确拒绝，而不是静默写入。
await assert.rejects(
  () => favoriteTool.execute({ sessionId: 'ui-1' }, {}),
  (error) => String(error.message).includes('autoArchive'),
)
await assert.rejects(
  () => favoriteTool.execute({ list: true }, {}),
  (error) => String(error.message).includes('autoArchive'),
)

// autoArchive=true 的那个挂载（ctx2）才是收藏可用的形态。
const favoriteToolOn = tools2.get('session_bridge_favorite')
const favorited = await favoriteToolOn.execute({ sessionId: 'ui-1' }, {})
assert.equal(favorited.favorite, true)
assert.deepEqual(favorited.sessionIds, ['ui-1'])
assert.equal(favorited.total, 1)
assert.deepEqual(JSON.parse(JSON.stringify(favorited)), favorited)

const listed = await favoriteToolOn.execute({}, {})
assert.deepEqual(listed.sessionIds, ['ui-1'])
assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)

const unfavorited = await favoriteToolOn.execute({ sessionId: 'ui-1', favorite: false }, {})
assert.deepEqual(unfavorited.sessionIds, [])
assert.equal(unfavorited.total, 0)

// 收藏与置顶无关：archive/unarchive 的语义不受影响（上面已断言），且没有调用 pin。
assert.equal(typeof ctx.workspaceRegistry.pinSession, 'undefined', 'the bundle must never call pinSession for favorites')

const favoritesRoute = routes.find((route) => route.path === '/session-bridge/favorites')
assert.ok(favoritesRoute !== undefined, 'apply() must mount the favorites route when webServer exists')
assert.equal(favoritesRoute.kind, 'exact')

// 设置页的数据面：同一条 webServer 上再挂一条 /session-bridge/settings。
const settingsRoute = routes.find((route) => route.path === '/session-bridge/settings')
assert.ok(settingsRoute !== undefined, 'apply() must mount the settings route when webServer exists')
assert.equal(settingsRoute.kind, 'exact')

/** 驱动一条路由处理器（node:http 风格桩）。 */
async function callRoute(route, { method = 'GET', body } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { res.headers[name.toLowerCase()] = value },
    end(value) { res.body = value },
  }
  const req = {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  }
  route.handler(req, res)
  await new Promise((done) => setTimeout(done, 10))
  return { status: res.statusCode, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

const settingsGet = await callRoute(settingsRoute)
assert.equal(settingsGet.status, 200)
assert.equal(settingsGet.json.settings.autoArchive, false, 'the shipped default must be "auto-archive off"')
assert.equal(settingsGet.json.settings.autoArchiveDays, 7, 'the shipped default must be 7 days')

// 本桩没有 configEditor：写回必须明确报失败，而不是假装成功。
const settingsPost = await callRoute(settingsRoute, { method: 'POST', body: { autoArchiveDays: 30 } })
assert.equal(settingsPost.status, 200)
assert.equal(settingsPost.json.ok, false, 'without configEditor the write must report failure')
assert.ok(String(settingsPost.json.message).length > 0, 'the failure must carry a reason')

assert.ok(timers.intervals.includes(3_600_000), 'auto-archive must schedule an hourly interval')
assert.ok(timers.timeouts.includes(60_000), 'auto-archive must run a first pass shortly after startup')

for (const marker of ['auto-archive', 'session-bridge/favorites', '/session-bridge/favorites', '/session-bridge/settings']) {
  assert.ok(bundleWithSwitch.includes(marker), 'the rebuilt bundle must inline favorites/auto-archive wiring: ' + marker)
}
assert.ok(
  readFileSync(join(HOME, 'session-bridge-favorites.json'), 'utf8').includes('sessionIds'),
  'the favorite set must persist under DSH_HOME',
)

console.log('smoke-bundle: OK — lib/index.js mounts and registers ' + String(tools.size) + ' tools')
