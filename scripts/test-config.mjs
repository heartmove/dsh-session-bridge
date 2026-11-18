#!/usr/bin/env node
/**
 * 回归测试：思维链循环自动中断的「两种开启方式」。
 *
 *  1. 设置页开关：Config 的每个字段都必须是 volatile（dsh-settings 只把 volatile
 *     字段渲染成设置页控件），且 Loader 解析后是稳定引用（改值不重载插件）。
 *  2. 命令开关：/cot-loop 的解析、写回配置、写不回时的内存退化、错误提示。
 *
 * 直接跑 src/*.ts（node --experimental-strip-types），与其余脚本一致。
 */
import assert from 'node:assert/strict'
import { Config, LOOP_DESCENDANTS_VALUES, LOOP_FIELD_VALUES, createArchivePolicy, createLoopPolicy, parseSessionIdList, readValue } from '../src/config.ts'
import { COMMAND_NAME, ENTRY_ID, createConfigWriter, loopCommandStatus, registerLoopCommands, runLoopCommand } from '../src/commands.ts'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ok ' + label)
}

// ---------- 1) 设置页开关：schema 契约 ----------
const json = Config.toJSON()
// schemastery 的 toJSON() 是 {uid, refs} 去重表：顶层对象挂在 refs[uid] 上。
const root = json.refs?.[String(json.uid)] ?? json
const fields = Object.keys(root.dict ?? {})
assert.ok(fields.length >= 9, 'Config must declare the loop knobs, got ' + JSON.stringify(Object.keys(root)))
const volatileFields = Object.entries(root.dict).filter(([, node]) => {
  const resolved = json.refs?.[String(node)] ?? node
  return resolved.meta?.volatile === true
})
assert.equal(
  volatileFields.length,
  fields.length,
  'every loop knob must be volatile — dsh-settings renders only volatile fields; missing: '
    + JSON.stringify(Object.keys(root.dict).filter((key) => !volatileFields.some(([name]) => name === key))),
)
ok('Config declares ' + String(fields.length) + ' volatile fields (settings form can render every knob)')

// Loader 语义：volatile 字段解析成稳定引用，读 .get()
const parsed = Config({})
assert.equal(typeof parsed.loopGuard?.get, 'function', 'parsed volatile field must be a stable reference')
assert.equal(parsed.loopGuard.get(), true, 'loopGuard default must be true (feature on by default)')
assert.equal(parsed.loopField.get(), 'reasoning', 'loopField default must be reasoning (chain-of-thought)')
assert.equal(parsed.loopMaxTransfers.get(), 3, 'loopMaxTransfers default must be 3')
ok('parsed config exposes stable volatile references with the documented defaults')

// readValue 兼容引用与裸值
assert.equal(readValue(true), true)
assert.equal(readValue({ get: () => false }), false)
assert.equal(readValue(undefined), undefined)
ok('readValue accepts both volatile references and plain values')

// 自动归档的三个设置项：默认“不归档 + 7 天 + 空名单”，且都必须是 settings 页可渲染的 volatile 字段。
assert.ok(fields.includes('autoArchive'), 'Config must declare autoArchive')
assert.ok(fields.includes('autoArchiveDays'), 'Config must declare autoArchiveDays')
assert.ok(fields.includes('autoArchiveExclude'), 'Config must declare autoArchiveExclude')
assert.equal(parsed.autoArchive.get(), false, 'autoArchive default must be false (no archiving out of the box)')
assert.equal(parsed.autoArchiveDays.get(), 7, 'autoArchiveDays default must be 7')
assert.equal(parsed.autoArchiveExclude.get(), '', 'autoArchiveExclude default must be empty')
ok('auto-archive knobs default to off / 7 days / empty exclusion list')

// ---------- 2) 策略：总开关与默认值 ----------
assert.equal(createLoopPolicy(undefined).enabled(), true, 'no config → feature on')
assert.equal(createLoopPolicy({ loopGuard: false }).enabled(), false, 'loopGuard:false → feature off')
assert.equal(createLoopPolicy({ loopGuard: { get: () => false } }).enabled(), false, 'volatile reference form is honoured')
ok('policy reads the switch from plain config and from volatile references')

// 引用原地更新 = 设置页改开关后，已运行的守护下一个 tick 就换新值（无需重载）
let live = true
const policy = createLoopPolicy({ loopGuard: { get: () => live } })
assert.equal(policy.enabled(), true)
live = false
assert.equal(policy.enabled(), false, 'a volatile reference update must be visible immediately')
ok('a live volatile update flips the switch without a plugin reload')

// 内存覆盖优先，reset 后回到配置
policy.setOverride(true)
assert.equal(policy.enabled(), true)
policy.setOverride(undefined)
assert.equal(policy.enabled(), false)
ok('in-memory override wins, and reset falls back to the config value')

const defaults = createLoopPolicy({
  loopField: 'nope',
  loopMinCycles: 999,
  loopMinRepeats: 0,
  loopMinConfidence: 5,
  loopMinHits: 2,
  loopCooldownMs: -1,
  loopMaxTransfers: 0,
  loopDescendants: 'whatever',
}).defaults()
assert.equal(defaults.field, 'reasoning', 'unknown enum value falls back to the default')
assert.equal(defaults.minCycles, 64, 'out-of-range number is clamped')
assert.equal(defaults.minRepeats, 2, 'below-range number is clamped to the floor')
assert.equal(defaults.minConfidence, 1, 'confidence is clamped to 1')
assert.equal(defaults.minHits, 2)
assert.equal(defaults.cooldownMs, 0)
assert.equal(defaults.maxTransfers, 0)
assert.equal(defaults.descendants, 'report')
ok('invalid config values fall back / clamp instead of breaking the guard')

// ---------- 3) 命令：/cot-loop ----------
const writes = []
const deps = (writeResult = { ok: true, message: 'written' }) => {
  const local = createLoopPolicy({ loopGuard: true })
  return {
    policy: local,
    writeConfig: async (patch) => {
      writes.push(patch)
      return writeResult
    },
  }
}

const status = await runLoopCommand('status', deps())
assert.equal(status.kind, 'success')
assert.ok(status.text.includes('开启'), 'status must report the switch state')
assert.ok(status.text.includes('field=reasoning'), 'status must report the scan field')
assert.ok(status.text.includes(ENTRY_ID), 'status must point at the settings page entry')
ok('status reports switch, parameters and the settings entry')

const empty = await runLoopCommand('', deps())
assert.equal(empty.kind, 'success', 'no input defaults to status')
ok('bare /cot-loop shows status')

writes.length = 0
// 真实链路：命令写回配置 → Loader 提交 volatile → 引用更新 → 开关立即变（测试里用可变引用模拟）
let liveGuard = true
const offDeps = {
  policy: createLoopPolicy({ loopGuard: { get: () => liveGuard } }),
  writeConfig: async (patch) => {
    writes.push(patch)
    if (typeof patch.loopGuard === 'boolean') liveGuard = patch.loopGuard
    return { ok: true, message: 'written' }
  },
}
const off = await runLoopCommand('off', offDeps)
assert.equal(off.kind, 'success')
assert.deepEqual(writes.at(-1), { loopGuard: false }, 'off must write loopGuard:false into the config')
assert.equal(offDeps.policy.enabled(), false, 'off must flip the live switch as soon as the config lands')
assert.equal(offDeps.policy.override(), undefined, 'a successful write must not leave an in-memory override')
assert.ok(off.text.includes('立即生效'), 'a persisted switch must say it applies immediately')
const on = await runLoopCommand('on', offDeps)
assert.equal(on.kind, 'success')
assert.deepEqual(writes.at(-1), { loopGuard: true })
assert.equal(offDeps.policy.enabled(), true, 'on must flip it back')
ok('off/on write the config and flip the live switch immediately')

writes.length = 0
const fallbackDeps = deps({ ok: false, message: 'no configEditor' })
const fallback = await runLoopCommand('off', fallbackDeps)
assert.equal(fallback.kind, 'success')
assert.equal(fallbackDeps.policy.enabled(), false, 'without a config writer the in-memory switch still applies')
assert.equal(fallbackDeps.policy.override(), false)
assert.ok(fallback.text.includes('内存'), 'the fallback must say the switch is in-memory only')
ok('without configEditor the command degrades to an in-memory switch and says so')

writes.length = 0
await runLoopCommand('field text', deps())
assert.deepEqual(writes.at(-1), { loopField: 'text' })
await runLoopCommand('descendants stop', deps())
assert.deepEqual(writes.at(-1), { loopDescendants: 'stop' })
await runLoopCommand('max-transfers 5', deps())
assert.deepEqual(writes.at(-1), { loopMaxTransfers: 5 })
await runLoopCommand('min-cycles 4', deps())
assert.deepEqual(writes.at(-1), { loopMinCycles: 4 })
await runLoopCommand('min-repeats 6', deps())
assert.deepEqual(writes.at(-1), { loopMinRepeats: 6 })
await runLoopCommand('min-hits 3', deps())
assert.deepEqual(writes.at(-1), { loopMinHits: 3 })
await runLoopCommand('cooldown 120000', deps())
assert.deepEqual(writes.at(-1), { loopCooldownMs: 120000 })
await runLoopCommand('confidence 0.8', deps())
assert.deepEqual(writes.at(-1), { loopMinConfidence: 0.8 })
ok('parameter subcommands write the matching config field')

for (const [input, needle] of [
  ['field nope', 'reasoning'],
  ['descendants nope', 'report'],
  ['max-transfers abc', 'max-transfers'],
  ['min-cycles abc', 'min-cycles'],
  ['confidence abc', 'confidence'],
]) {
  const bad = await runLoopCommand(input, deps())
  assert.equal(bad.kind, 'error', input + ' must be rejected')
  assert.ok(bad.text.includes(needle), input + ' error must explain the expected value')
}
const unknown = await runLoopCommand('nonsense', deps())
assert.equal(unknown.kind, 'error')
assert.ok(unknown.text.includes('/cot-loop'), 'unknown subcommand must print usage')
ok('invalid input is rejected with actionable text')

const resetDeps = deps()
resetDeps.policy.setOverride(false)
await runLoopCommand('reset', resetDeps)
assert.equal(resetDeps.policy.override(), undefined)
assert.equal(resetDeps.policy.enabled(), true, 'reset returns to the config value')
ok('reset drops the in-memory override')

assert.ok(loopCommandStatus({ policy: createLoopPolicy({ loopGuard: false }), writeConfig: async () => ({ ok: true, message: '' }) }).includes('关闭'))
ok('status reflects a disabled switch')

// ---------- 3b) 自动归档策略 ----------
const archiveDefaults = createArchivePolicy(undefined)
assert.equal(archiveDefaults.enabled(), false, 'auto-archive must default to off')
assert.equal(archiveDefaults.days(), 7, 'auto-archive must default to 7 days')
assert.equal(archiveDefaults.exclude().size, 0, 'no exclusion-list entries by default')

const archiveCustom = createArchivePolicy({
  autoArchive: true,
  autoArchiveDays: 30,
  autoArchiveExclude: ' a, b\nc ;a ',
})
assert.equal(archiveCustom.enabled(), true)
assert.equal(archiveCustom.days(), 30)
assert.deepEqual([...archiveCustom.exclude()].sort(), ['a', 'b', 'c'], 'comma/space/semicolon separated ids, de-duplicated')

assert.equal(createArchivePolicy({ autoArchiveDays: 0 }).days(), 1, 'days clamp to the floor')
assert.equal(createArchivePolicy({ autoArchiveDays: 99999 }).days(), 3650, 'days clamp to the ceiling')
assert.equal(createArchivePolicy({ autoArchiveDays: 'soon' }).days(), 7, 'invalid days fall back to 7')
assert.equal(createArchivePolicy({ autoArchive: 'yes' }).enabled(), false, 'only a real boolean enables archiving')

let liveArchive = false
const liveArchivePolicy = createArchivePolicy({ autoArchive: { get: () => liveArchive } })
assert.equal(liveArchivePolicy.enabled(), false)
liveArchive = true
assert.equal(liveArchivePolicy.enabled(), true, 'a live volatile update must flip the switch without a reload')

assert.equal(parseSessionIdList(undefined).size, 0)
assert.equal(parseSessionIdList('   ').size, 0)
assert.equal(parseSessionIdList(42).size, 0)
assert.deepEqual([...parseSessionIdList('x y')], ['x', 'y'])
ok('createArchivePolicy reads live volatile values, parses the list and clamps the day count')

// ---------- 4) 命令注册：可选服务探测 ----------
const registered = []
const stubCtx = (services) => ({
  inject: (names, callback) => {
    const child = {}
    for (const name of names) if (name in services) child[name] = services[name]
    callback(child)
  },
})
registerLoopCommands(stubCtx({ commands: { register: (definition) => registered.push(definition) } }), { policy: createLoopPolicy(), writeConfig: async () => ({ ok: true, message: '' }) })
assert.equal(registered.length, 1, 'the command must be registered when the service exists')
assert.equal(registered[0].name, COMMAND_NAME)
assert.ok(registered[0].input.hint.includes('off'), 'the command must advertise its input')
const handlerResult = await registered[0].handler({ rawInput: 'status' })
assert.equal(handlerResult.kind, 'success', 'the registered handler must be async-capable and work')
ok('registerLoopCommands registers ' + COMMAND_NAME + ' when commands exists')

registerLoopCommands(stubCtx({}), { policy: createLoopPolicy(), writeConfig: async () => ({ ok: true, message: '' }) })
registerLoopCommands({}, { policy: createLoopPolicy(), writeConfig: async () => ({ ok: true, message: '' }) })
ok('registration is skipped silently when the service (or inject) is missing')

// ---------- 5) 写回配置：定位 entry ----------
const edits = []
const writer = createConfigWriter(stubCtx({
  configEditor: {
    entries: () => [{ options: { id: 'other-plugin' } }, { options: { id: ENTRY_ID, name: ENTRY_ID } }],
    edit: async (entry, change) => {
      edits.push(change({ loopGuard: true, loopField: 'text' }, {}))
    },
  },
}))
const writeOk = await writer({ loopGuard: false })
assert.equal(writeOk.ok, true, 'writer must find the entry by id')
assert.deepEqual(edits.at(-1), { loopGuard: false, loopField: 'text' }, 'writer must merge the patch into the current config')
ok('createConfigWriter locates the plugin entry and merges the patch')

const writerMissing = createConfigWriter(stubCtx({ configEditor: { entries: () => [], edit: async () => {} } }))
assert.equal((await writerMissing({ loopGuard: false })).ok, false)
const writerNone = createConfigWriter(stubCtx({}))
const noneResult = await writerNone({ loopGuard: false })
assert.equal(noneResult.ok, false)
assert.ok(noneResult.message.includes('configEditor'))
ok('createConfigWriter reports a usable reason when the entry or service is missing')

assert.equal(LOOP_FIELD_VALUES.length, 3)
assert.equal(LOOP_DESCENDANTS_VALUES.length, 3)
ok('documented enum values are stable')

console.log('\ntest-config: ' + String(passed) + ' checks passed')
