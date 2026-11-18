#!/usr/bin/env node
/**
 * 收藏回归：存储 + 同源 HTTP 路由。
 *
 * 收藏是用户明确要求的“独立于置顶”的标记：
 *  - 持久化在 ~/.dsh/session-bridge-favorites.json（这里用临时文件注入路径）；
 *  - 与工具/UI 共用同一 FavoritesStore；
 *  - 浏览器半通过 `/session-bridge/favorites` 读写，必须守住认证与 body 边界。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FavoritesStore } from '../src/favorites.ts'
import { FAVORITES_ROUTE_PATH, handleFavoritesRequest, isLoopbackAddress } from '../src/routes.ts'
import { registerBridgeTools } from '../src/tools.ts'

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

/** 临时目录里的 store（每个用例独立文件）。 */
async function withStore(fn, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-favorites-'))
  const file = join(dir, 'favorites.json')
  try {
    if (initial !== undefined) await writeFile(file, initial, 'utf8')
    const store = new FavoritesStore(file)
    await fn(store, file, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function request({ method = 'GET', headers = {}, body, address = '127.0.0.1' } = {}) {
  const bag = {
    method,
    headers,
    socket: { remoteAddress: address },
  }
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

/** 一个带 connection 服务的 host 桩（模拟 Web 组合的认证入口）。 */
function hostWithConnection(rejection) {
  return { get: (name) => (name === 'connection' ? { requestRejection: () => rejection } : undefined) }
}

// ---------- 1) 存储 ----------
await test('a missing file loads as an empty favorite set', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.list(), [])
    assert.equal(await store.has('x'), false)
    assert.deepEqual(await store.snapshot(), { sessionIds: [], updatedAt: 0 })
  })
})

await test('favorite / unfavorite are idempotent and persist the order', async () => {
  await withStore(async (store, file) => {
    await store.set('a')
    await store.set('b')
    await store.set('b')
    assert.deepEqual(await store.list(), ['a', 'b'])
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(stored.sessionIds, ['a', 'b'])
    assert.ok(stored.updatedAt > 0)

    const updatedAt = stored.updatedAt
    await store.set('b', true)
    assert.equal((await store.snapshot()).updatedAt, updatedAt, 're-favoriting must not rewrite')

    const after = await store.set('a', false)
    assert.deepEqual(after.sessionIds, ['b'])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sessionIds, ['b'])
    assert.deepEqual((await store.set('a', false)).sessionIds, ['b'], 'removing an absent id is a no-op')
  })
})

await test('a fresh store instance sees the persisted favorites', async () => {
  await withStore(async (store, file) => {
    await store.set('kept')
    const reopened = new FavoritesStore(file)
    assert.deepEqual(await reopened.list(), ['kept'])
  })
})

await test('a corrupt file loads as empty and stays writable', async () => {
  await withStore(async (store, file) => {
    assert.deepEqual(await store.list(), [])
    await store.set('recovered')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sessionIds, ['recovered'])
  }, '{ not json')
})

await test('concurrent updates serialize into one complete file', async () => {
  await withStore(async (store, file) => {
    await Promise.all([store.set('a'), store.set('b'), store.set('c')])
    assert.deepEqual((await store.list()).sort(), ['a', 'b', 'c'])
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(stored.sessionIds.slice().sort(), ['a', 'b', 'c'])
  })
})

await test('subscribers observe committed changes only', async () => {
  await withStore(async (store) => {
    const seen = []
    const off = store.subscribe((snapshot) => seen.push(snapshot.sessionIds))
    await store.set('a')
    await store.set('a')
    await store.set('a', false)
    off()
    await store.set('b')
    assert.deepEqual(seen, [['a'], []], 're-favorite and unsubscribed changes must not emit')
  })
})

await test('an invalid session id is rejected', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.set('   '), /invalid sessionId/)
  })
})

// ---------- 2) 路由 ----------
await test('GET returns the favorite snapshot with no-store headers', async () => {
  await withStore(async (store) => {
    await store.set('a')
    const res = response()
    const status = await handleFavoritesRequest({ get: () => undefined }, store, request(), res)
    assert.equal(status, 200)
    const body = res.json()
    assert.deepEqual(body.sessionIds, ['a'])
    assert.equal(typeof body.updatedAt, 'number')
    assert.equal(res.headers['cache-control'], 'no-store')
  })
})

await test('POST favorites and unfavorites, echoing the affected id', async () => {
  await withStore(async (store) => {
    const host = { get: () => undefined }
    const post = async (payload) => {
      const res = response()
      const status = await handleFavoritesRequest(
        host,
        store,
        request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        res,
      )
      return { status, body: res.body === undefined ? undefined : res.json() }
    }

    const favorited = await post({ sessionId: 's1', favorite: true })
    assert.equal(favorited.status, 200)
    assert.equal(favorited.body.sessionId, 's1')
    assert.equal(favorited.body.favorite, true)
    assert.deepEqual(favorited.body.sessionIds, ['s1'])
    assert.equal(await store.has('s1'), true)

    const unfavorited = await post({ sessionId: 's1', favorite: false })
    assert.equal(unfavorited.status, 200)
    assert.equal(unfavorited.body.favorite, false)
    assert.deepEqual(unfavorited.body.sessionIds, [])
    assert.equal(await store.has('s1'), false)
  })
})

await test('POST defaults to favoriting when favorite is omitted', async () => {
  await withStore(async (store) => {
    const status = await handleFavoritesRequest(
      { get: () => undefined },
      store,
      request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's2' }) }),
      response(),
    )
    assert.equal(status, 200)
    assert.equal(await store.has('s2'), true)
  })
})

await test('request validation: media type, empty id, non-boolean favorite, unknown method', async () => {
  await withStore(async (store) => {
    const host = { get: () => undefined }
    const noType = response()
    assert.equal(await handleFavoritesRequest(host, store, request({ method: 'POST', body: '{}' }), noType), 415)
    assert.equal(noType.json().code, 'unsupported-media-type')

    const emptyId = response()
    assert.equal(await handleFavoritesRequest(
      host, store,
      request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: ' ' }) }),
      emptyId,
    ), 400)
    assert.equal(emptyId.json().code, 'invalid-session-id')

    const badFavorite = response()
    assert.equal(await handleFavoritesRequest(
      host, store,
      request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's', favorite: 'yes' }) }),
      badFavorite,
    ), 400)
    assert.equal(badFavorite.json().code, 'invalid-favorite')

    const put = response()
    assert.equal(await handleFavoritesRequest(host, store, request({ method: 'PUT' }), put), 405)
    assert.equal(put.headers.allow, 'GET, POST')
  })
})

await test('an oversized body is rejected without touching the store', async () => {
  await withStore(async (store) => {
    const res = response()
    const status = await handleFavoritesRequest(
      { get: () => undefined },
      store,
      request({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'x', padding: 'y'.repeat(5000) }),
      }),
      res,
    )
    assert.equal(status, 400)
    assert.equal(res.json().code, 'invalid-body')
    assert.deepEqual(await store.list(), [])
  })
})

await test('a rejected connection is refused before any store access', async () => {
  await withStore(async (store) => {
    const res = response()
    const status = await handleFavoritesRequest(hostWithConnection(401), store, request(), res)
    assert.equal(status, 401)
    assert.equal(res.body, undefined)
    assert.deepEqual(await store.list(), [])
  })
})

await test('without a connection service only loopback peers are admitted', async () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.7'), false)
  assert.equal(isLoopbackAddress(undefined), false)

  await withStore(async (store) => {
    const remote = response()
    assert.equal(await handleFavoritesRequest({ get: () => undefined }, store, request({ address: '10.0.0.5' }), remote), 403)
    const local = response()
    assert.equal(await handleFavoritesRequest({ get: () => undefined }, store, request({ address: '::1' }), local), 200)
  })
})

/** 只注册工具的最小宿主；archiveOn 决定自动归档开关（收藏功能的总闸门）。 */
function toolHarness(store, archiveOn) {
  const registered = new Map()
  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    workspaceRegistry: { archivedSessionIds: [], list: () => [], get: () => undefined, resolveByPath: async () => undefined },
    sessionPersistence: { open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }) },
    agents: { get: () => undefined, list: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { all: async () => [], record() {}, touch() {}, load: async () => {}, persist: async () => {} }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  const policy = { enabled: () => true, override: () => undefined, setOverride() {}, defaults: () => ({}), hasConfig: () => true }
  const archive = { enabled: () => archiveOn, days: () => 7, exclude: () => new Set() }
  registerBridgeTools({ ctx, registry, monitor, favorites: store, policy, archive })
  return registered.get('session_bridge_favorite')
}

await test('the favorite tool is unavailable while auto-archive is off', async () => {
  await withStore(async (store) => {
    const tool = toolHarness(store, false)
    await assert.rejects(() => tool.execute({ sessionId: 's1' }, {}), /autoArchive|unavailable/)
    await assert.rejects(() => tool.execute({ list: true }, {}), /autoArchive|unavailable/)
    assert.deepEqual(await store.list(), [], 'a refused call must not touch the store')
  })
})

await test('the favorite tool works once auto-archive is on', async () => {
  await withStore(async (store) => {
    const tool = toolHarness(store, true)
    const value = await tool.execute({ sessionId: 's1' }, {})
    assert.equal(value.favorite, true)
    assert.deepEqual(value.sessionIds, ['s1'])
    assert.deepEqual(await store.list(), ['s1'])
  })
})

await test('the route path is stable', async () => {
  assert.equal(FAVORITES_ROUTE_PATH, '/session-bridge/favorites')
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)