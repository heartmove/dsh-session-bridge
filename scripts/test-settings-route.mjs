#!/usr/bin/env node
/**
 * 设置路由回归：`/session-bridge/settings` 的读写与校验。
 *
 * 设置页（`settings.section`）不能直接写插件配置，它经这条同源路由把四个 volatile
 * 字段交给 host，host 再走与 `/cot-loop` 相同的 configEditor 写回路径。因此这里锁死：
 *  - GET 返回当前生效值与 writable；
 *  - POST 只接受四个字段，逐项校验，非法值整体拒绝（不做部分成功）；
 *  - 写回失败（被更高层覆盖）不是请求错误：200 + ok:false + 原因；
 *  - 认证与收藏路由同一套（connection 拒绝优先）。
 */
import assert from 'node:assert/strict'
import { SETTINGS_ROUTE_PATH, handleSettingsRequest } from '../src/routes.ts'

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

function request({ method = 'GET', headers = {}, body, address = '127.0.0.1' } = {}) {
  const bag = { method, headers, socket: { remoteAddress: address } }
  bag[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(body)
  }
  return bag
}

function response() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { res.headers[name.toLowerCase()] = value },
    end(body) { res.body = body },
    json() { return JSON.parse(res.body) },
  }
  return res
}

/** 一个带状态的假设置源：write 直接改 settings，模拟 volatile 立即生效。 */
function deps(initial = {}, options = {}) {
  const settings = {
    autoArchive: false,
    autoArchiveDays: 7,
    autoArchiveExclude: '',
    loopGuard: true,
    ...initial,
  }
  const writes = []
  return {
    settings,
    writes,
    value: {
      read: () => ({ ...settings }),
      write: async (patch) => {
        writes.push(patch)
        if (options.writeResult !== undefined) return options.writeResult
        Object.assign(settings, patch)
        return { ok: true, message: 'written' }
      },
      writable: () => options.writable !== false,
    },
  }
}

const host = { get: () => undefined }

await test('GET returns the effective settings and writability', async () => {
  const harness = deps({ autoArchive: true, autoArchiveDays: 30 })
  const res = response()
  const status = await handleSettingsRequest(host, harness.value, request(), res)
  assert.equal(status, 200)
  assert.deepEqual(res.json(), {
    settings: { autoArchive: true, autoArchiveDays: 30, autoArchiveExclude: '', loopGuard: true },
    writable: true,
  })
  assert.equal(res.headers['cache-control'], 'no-store')
})

await test('POST writes every supported field and returns the new values', async () => {
  const harness = deps()
  const res = response()
  const status = await handleSettingsRequest(host, harness.value, request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoArchive: true, autoArchiveDays: 14, autoArchiveExclude: 'a, b', loopGuard: false }),
  }), res)
  assert.equal(status, 200)
  assert.deepEqual(harness.writes, [{ autoArchive: true, autoArchiveDays: 14, autoArchiveExclude: 'a, b', loopGuard: false }])
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.settings, { autoArchive: true, autoArchiveDays: 14, autoArchiveExclude: 'a, b', loopGuard: false })
})

await test('POST writes only the supplied fields (partial update)', async () => {
  const harness = deps({ autoArchiveDays: 3 })
  const status = await handleSettingsRequest(host, harness.value, request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoArchive: true }),
  }), response())
  assert.equal(status, 200)
  assert.deepEqual(harness.writes, [{ autoArchive: true }])
  assert.equal(harness.settings.autoArchiveDays, 3, 'untouched fields keep their values')
})

await test('POST clamps days into 1..3650', async () => {
  const low = deps()
  await handleSettingsRequest(host, low.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoArchiveDays: 0 }),
  }), response())
  assert.equal(low.writes[0].autoArchiveDays, 1)

  const high = deps()
  await handleSettingsRequest(host, high.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoArchiveDays: 99999 }),
  }), response())
  assert.equal(high.writes[0].autoArchiveDays, 3650)

  const rounded = deps()
  await handleSettingsRequest(host, rounded.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoArchiveDays: 7.6 }),
  }), response())
  assert.equal(rounded.writes[0].autoArchiveDays, 8)
})

await test('invalid values are rejected as a whole request', async () => {
  for (const [payload, code] of [
    [{ autoArchive: 'yes' }, 'invalid-auto-archive'],
    [{ loopGuard: 1 }, 'invalid-loop-guard'],
    [{ autoArchiveDays: 'soon' }, 'invalid-auto-archive-days'],
    [{ autoArchiveExclude: 42 }, 'invalid-auto-archive-exclude'],
    [{ autoArchiveExclude: 'x'.repeat(5000) }, 'invalid-auto-archive-exclude'],
    [{}, 'empty-patch'],
    [{ unknownField: true }, 'empty-patch'],
  ]) {
    const harness = deps()
    const res = response()
    const status = await handleSettingsRequest(host, harness.value, request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }), res)
    assert.equal(status, 400, JSON.stringify(payload) + ' must be rejected')
    assert.equal(res.json().code, code, JSON.stringify(payload) + ' must report ' + code)
    assert.deepEqual(harness.writes, [], 'a rejected request must not reach the config writer')
  }
})

await test('a rejected write is reported, not hidden', async () => {
  const harness = deps({}, { writeResult: { ok: false, message: 'overridden by a higher layer' } })
  const res = response()
  const status = await handleSettingsRequest(host, harness.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoArchive: true }),
  }), res)
  assert.equal(status, 200, 'a write refusal is not a malformed request')
  assert.equal(res.json().ok, false)
  assert.match(res.json().message, /overridden/)
})

await test('read-only deployments advertise it', async () => {
  const harness = deps({}, { writable: false })
  const res = response()
  await handleSettingsRequest(host, harness.value, request(), res)
  assert.equal(res.json().writable, false)
})

await test('media type, method and body shape are enforced', async () => {
  const harness = deps()
  const noType = response()
  assert.equal(await handleSettingsRequest(host, harness.value, request({ method: 'POST', body: '{}' }), noType), 415)
  assert.equal(noType.json().code, 'unsupported-media-type')

  const put = response()
  assert.equal(await handleSettingsRequest(host, harness.value, request({ method: 'PUT' }), put), 405)
  assert.equal(put.headers.allow, 'GET, POST')

  const array = response()
  assert.equal(await handleSettingsRequest(host, harness.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]',
  }), array), 400)
  assert.equal(array.json().code, 'invalid-body')

  const broken = response()
  assert.equal(await handleSettingsRequest(host, harness.value, request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ oops',
  }), broken), 400)
  assert.equal(broken.json().code, 'invalid-body')
})

await test('a rejected connection and a non-loopback peer are refused first', async () => {
  const harness = deps()
  const blocked = response()
  const rejectingHost = { get: () => ({ requestRejection: () => 401 }) }
  assert.equal(await handleSettingsRequest(rejectingHost, harness.value, request(), blocked), 401)
  assert.equal(blocked.body, undefined)

  const remote = response()
  assert.equal(await handleSettingsRequest(host, harness.value, request({ address: '10.1.2.3' }), remote), 403)
  assert.deepEqual(harness.writes, [])
})

await test('the route path is stable', async () => {
  assert.equal(SETTINGS_ROUTE_PATH, '/session-bridge/settings')
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)