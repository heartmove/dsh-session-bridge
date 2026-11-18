#!/usr/bin/env node
/**
 * Client bundle 形状回归（不启动浏览器）。
 *
 * 浏览器半是手写的 module-loader bundle：加载它只需要一个 `window.__ModuleLoader__`
 * 和一个 React。这里用一个**迷你 hooks 运行时**（useState 真的会触发重渲染、useEffect
 * 只在 deps 为空时执行一次），因此可以断言组件真的渲染到 ready 状态，而不是只看到骨架：
 *
 *  - 包 id 正确、工厂只 require('react')，插件注入 slots / locale；
 *  - locale 字典（en + zh）与四个投放面：菜单动作、两个菜单图标 key、行尾 ★、设置页；
 *  - 菜单文案/图标随收藏切换，点击走 POST；
 *  - ★ 只在收藏时渲染；
 *  - 自动归档关闭时收藏整套 UI（菜单项 / ★ / 设置页收藏区）都不出现；
 *  - 设置页在真实重渲染后显示四个控件；任一渲染异常会显示成页面文本（不是白屏）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'client', 'index.js')

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

const ZH = {
  favorite: '收藏',
  unfavorite: '取消收藏',
  favorited: '已收藏',
  section: '会话归档',
}

/**
 * 迷你 React + hooks 运行时。
 * `useState` 的 setter 会真的改掉槽位并置 dirty；`useEffect` 在 deps 未变化时只跑一次。
 */
function createRuntime() {
  const hooks = []
  let cursor = 0
  let dirty = false
  const cleanups = []

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks.length <= index || hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[index]
      const setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        slot.value = value
        dirty = true
      }
      return [slot.value, setter]
    },
    useEffect(effect, deps) {
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      if (previous !== undefined && previous.ran === true) return
      hooks[index] = { ran: true }
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }

  return {
    React,
    beginRender() {
      cursor = 0
      dirty = false
    },
    get dirty() {
      return dirty
    },
    cleanups,
  }
}

/** 渲染到稳定（最多 20 轮），每轮让 effect 里的异步请求落地。 */
async function renderStable(component, props, runtime) {
  let tree
  for (let round = 0; round < 20; round += 1) {
    runtime.beginRender()
    tree = component(props)
    await new Promise((done) => setTimeout(done, 0))
    if (!runtime.dirty) break
  }
  return tree
}

/** 收集元素树里的所有文本片段。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => textOf(child))
  const own = [node.props && node.props.title].filter((value) => typeof value === 'string')
  return own.concat(textOf(node.children))
}

/** 按 type 收集元素。 */
function findAll(tree, type) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((child) => findAll(child, type))
  const here = tree.type === type ? [tree] : []
  return here.concat(findAll(tree.children, type))
}

/** 执行 bundle，返回加载到的定义。 */
function loadBundle() {
  const captured = []
  const fakeWindow = { __ModuleLoader__: { load: (definition) => captured.push(definition) } }
  new Function('window', readFileSync(SOURCE, 'utf8'))(fakeWindow)
  assert.equal(captured.length, 1, 'bundle must register exactly one module')
  return captured[0]
}

/** 构造可观察的 apply 上下文（含可选注入与 contextMenus）。 */
function createContext({ withMenus = true } = {}) {
  const state = {
    effects: [],
    locales: [],
    injections: [],
    registrations: [],
    menuContributions: [],
    iconKeys: [],
  }
  const slots = {
    inject(name, callback) {
      state.injections.push(name)
      callback()
      return () => {}
    },
    register(options, component) {
      state.registrations.push({ options, component })
      if (options.name === 'contextMenu.icon') state.iconKeys.push(options.key)
      return () => {}
    },
  }
  const child = { slots, effect: (callback, label) => { state.effects.push(label ?? ''); return callback() } }
  if (withMenus) {
    child.contextMenus = {
      register(contribution) {
        state.menuContributions.push(contribution)
        return () => {}
      },
    }
  }
  const ctx = {
    slots,
    effect(callback, label) {
      state.effects.push(label ?? '')
      return callback()
    },
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, dictionaries })
        return () => {}
      },
      // 与真实 locale 服务一致：bind 返回读取已注册字典的 t；字典缺失时回退成 key。
      bind: (namespace) => (key) => {
        const entry = state.locales.find((row) => row.namespace === namespace)
        const dict = entry === undefined ? undefined : entry.dictionaries.zh
        return dict !== undefined && typeof dict[key] === 'string' ? dict[key] : key
      },
      subscribe: () => () => {},
    },
    inject(names, callback) {
      for (const name of names) {
        if (name === 'contextMenus' && child.contextMenus !== undefined) callback(child)
      }
    },
    get: (name) => (name === 'contextMenus' ? child.contextMenus : undefined),
  }
  return { ctx, state }
}

/** 装一套 fetch 桩：/favorites 读写集合，/settings 读写四个字段。 */
function installFetch({ favorites = [], settings = { autoArchive: false, autoArchiveDays: 7, autoArchiveExclude: '', loopGuard: true } } = {}) {
  let current = [...favorites]
  let config = { ...settings }
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    if (String(url).endsWith('/session-bridge/settings')) {
      if (method === 'POST') {
        config = { ...config, ...body }
        return { ok: true, status: 200, async json() { return { ok: true, message: 'written', settings: config, writable: true } } }
      }
      return { ok: true, status: 200, async json() { return { settings: config, writable: true } } }
    }
    if (method === 'POST') {
      current = body.favorite === true
        ? [...new Set([...current, body.sessionId])]
        : current.filter((id) => id !== body.sessionId)
      return {
        ok: true,
        status: 200,
        async json() {
          return { sessionIds: [...current], updatedAt: 1, sessionId: body.sessionId, favorite: body.favorite === true }
        },
      }
    }
    return { ok: true, status: 200, async json() { return { sessionIds: [...current], updatedAt: 1 } } }
  }
  return { requests, current: () => [...current], config: () => ({ ...config }) }
}

/** 自动归档开启时的设置快照（收藏 UI 的显示条件）。 */
const ARCHIVE_ON = { autoArchive: true, autoArchiveDays: 7, autoArchiveExclude: '', loopGuard: true }

async function withGlobals(fn) {
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  try {
    globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
    return await fn()
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
}

/** 应用一次 bundle，返回上下文、状态与运行时。 */
async function mount(options = {}) {
  const runtime = createRuntime()
  const harness = installFetch(options.fetch)
  const plugin = loadBundle().factory(() => runtime.React)
  const { ctx, state } = createContext(options)
  plugin.apply(ctx)
  await new Promise((done) => setTimeout(done, 0))
  return { runtime, harness, state, ctx, plugin }
}

await test('the bundle registers the package id and only requires react', () => {
  const definition = loadBundle()
  assert.equal(definition.id, 'dsh-session-bridge')
  const plugin = definition.factory((name) => {
    if (name === 'react') return { createElement: () => null }
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

await test('applying registers en/zh dictionaries, the icon keys and three UI surfaces', async () => {
  await withGlobals(async () => {
    const { harness, state } = await mount({ fetch: { favorites: ['pre-favorited'] } })

    assert.equal(state.locales.length, 1)
    assert.equal(state.locales[0].namespace, 'dsh-session-bridge')
    assert.deepEqual(Object.keys(state.locales[0].dictionaries).sort(), ['en', 'zh'])
    for (const locale of ['en', 'zh']) {
      for (const key of ['favorite', 'unfavorite', 'favorited', 'section', 'autoArchive', 'days', 'exclude', 'save', 'renderFailed']) {
        assert.equal(typeof state.locales[0].dictionaries[locale][key], 'string', locale + '.' + key)
      }
    }

    assert.ok(state.injections.includes('settings.section.icon'), 'must register the settings nav icon')
    assert.ok(state.injections.includes('settings.section'), 'must register a settings page')
    assert.ok(state.injections.includes('sidebar.session.row.trailing'), 'must register the row star')
    assert.ok(state.injections.includes('contextMenu.icon'), 'must register its menu icon keys')
    assert.deepEqual(state.iconKeys, ['session-bridge.star-outline', 'session-bridge.star-fill'])

    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    assert.equal(section.options.id, 'dsh-session-bridge')
    assert.equal(section.options.label, '会话归档')
    const icon = state.registrations.find((row) => row.options.name === 'settings.section.icon')
    assert.equal(icon.options.id, section.options.id, 'the icon id must equal the section id')

    assert.equal(harness.requests.length, 2, 'the store loads favorites and the auto-archive switch once on apply')
    assert.equal(harness.requests[0].url, 'http://127.0.0.1:3080/session-bridge/favorites')
    assert.equal(harness.requests[1].url, 'http://127.0.0.1:3080/session-bridge/settings')
  })
})

await test('the session menu action uses ctx.contextMenus with the favorite state', async () => {
  await withGlobals(async () => {
    const { state } = await mount({ fetch: { favorites: [], settings: ARCHIVE_ON } })
    const contribution = state.menuContributions[0]
    assert.ok(contribution !== undefined, 'the bundle must register a session menu contribution')
    assert.equal(contribution.id, 'dsh-session-bridge.favorite')
    assert.equal(contribution.target, 'session')
    assert.equal(contribution.order, 550, 'the item sits before the shipped archive action (600)')

    const observed = contribution.observe({ sessionId: 's1', displayTitle: 'One' })
    assert.equal(observed.length, 1)
    assert.equal(typeof observed[0].getSnapshot, 'function')
    assert.equal(typeof observed[0].subscribe, 'function')

    const before = contribution.resolve({ sessionId: 's1', displayTitle: 'One' })
    assert.equal(before[0].label, '收藏')
    assert.equal(before[0].icon.key, 'session-bridge.star-outline')

    await before[0].run()
    await new Promise((done) => setTimeout(done, 0))

    const after = contribution.resolve({ sessionId: 's1', displayTitle: 'One' })
    assert.equal(after[0].label, '取消收藏')
    assert.equal(after[0].icon.key, 'session-bridge.star-fill')
  })
})

await test('the menu action POSTs the toggle to the favorites route', async () => {
  await withGlobals(async () => {
    const { harness, state } = await mount({ fetch: { favorites: [], settings: ARCHIVE_ON } })
    const action = state.menuContributions[0].resolve({ sessionId: 's1', displayTitle: 'One' })[0]
    await action.run()
    await new Promise((done) => setTimeout(done, 0))
    const request = harness.requests.at(-1)
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { sessionId: 's1', favorite: true })
    assert.deepEqual(harness.current(), ['s1'])
  })
})

await test('the row star renders only for favorited sessions', async () => {
  await withGlobals(async () => {
    const { runtime, state } = await mount({ fetch: { favorites: ['s1'], settings: ARCHIVE_ON } })
    const trailing = state.registrations.find((row) => row.options.name === 'sidebar.session.row.trailing')
    assert.equal(trailing.options.inject, undefined, 'the star must not depend on slot injection')
    const star = trailing.component({ sessionId: 's1' })
    assert.equal(star.type, 'span')
    assert.equal(star.props.title, '已收藏')
    assert.equal(star.props['aria-hidden'], true)
    assert.equal(trailing.component({ sessionId: 'other' }), null)
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('the settings page renders every control after real re-renders (never a blank page)', async () => {
  await withGlobals(async () => {
    const { runtime, state, harness } = await mount({
      fetch: { favorites: ['fav-1'], settings: { autoArchive: true, autoArchiveDays: 14, autoArchiveExclude: 'keep-me', loopGuard: false } },
    })
    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    assert.equal(section.options.inject, undefined, 'the settings page must not depend on slot injection')

    const tree = await renderStable(section.component, { close: () => {} }, runtime)
    const text = textOf(tree).join(' | ')

    assert.ok(text.includes('会话归档与收藏'), 'the page must render its title, got: ' + text)
    assert.ok(text.includes('自动归档长期未活动的会话'), 'the auto-archive switch must render')
    assert.ok(text.includes('超过多少天未活动就归档'), 'the day field must render')
    assert.ok(text.includes('永不自动归档的会话 id'), 'the exclusion field must render')
    assert.ok(text.includes('思维链陷入循环时自动中断'), 'the loop switch must render')
    assert.ok(text.includes('收藏'), 'the favorites section must render')
    assert.ok(text.includes('fav-1'), 'the favorites list must show the stored id')

    // 四个控件都真的存在，并且天数字段带着服务端返回的值。
    const inputs = findAll(tree, 'input')
    const checkboxes = inputs.filter((node) => node.props.type === 'checkbox')
    const numbers = inputs.filter((node) => node.props.type === 'number')
    assert.equal(checkboxes.length, 2, 'two boolean switches')
    assert.equal(numbers.length, 1, 'one numeric day field')
    assert.equal(numbers[0].props.value, 14, 'the day field shows the stored value')
    assert.equal(findAll(tree, 'textarea').length, 1, 'one exclusion textarea')
    assert.equal(findAll(tree, 'button').length >= 2, true, 'a save button plus one per favorite')

    assert.ok(harness.requests.some((request) => request.url.endsWith('/session-bridge/settings')), 'the page GETs the settings route')
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('a save POSTs the four volatile fields', async () => {
  await withGlobals(async () => {
    const { runtime, state, harness } = await mount({ fetch: { settings: { autoArchive: false, autoArchiveDays: 7, autoArchiveExclude: '', loopGuard: true } } })
    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    const tree = await renderStable(section.component, {}, runtime)

    // 打开自动归档开关：找到那个 checkbox 的 onChange，再点保存。
    const checkboxes = findAll(tree, 'input').filter((node) => node.props.type === 'checkbox')
    checkboxes[0].props.onChange({ target: { checked: true } })
    const afterToggle = await renderStable(section.component, {}, runtime)
    const saveButton = findAll(afterToggle, 'button').find((node) => textOf(node).join('') === '保存')
    assert.ok(saveButton !== undefined, 'the save button must be labelled 保存')
    await saveButton.props.onClick()
    await new Promise((done) => setTimeout(done, 0))

    const post = harness.requests.filter((request) => request.init.method === 'POST').at(-1)
    assert.ok(post !== undefined, 'saving must POST')
    assert.deepEqual(JSON.parse(post.init.body), {
      autoArchive: true,
      autoArchiveDays: 7,
      autoArchiveExclude: '',
      loopGuard: true,
    })
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('a failed settings load shows an error instead of a blank page', async () => {
  await withGlobals(async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    try {
      const runtime = createRuntime()
      const plugin = loadBundle().factory(() => runtime.React)
      const { ctx, state } = createContext()
      plugin.apply(ctx)
      const section = state.registrations.find((row) => row.options.name === 'settings.section')
      const tree = await renderStable(section.component, {}, runtime)
      const text = textOf(tree).join(' | ')
      assert.ok(text.includes('读取设置失败'), 'the failure must be visible, got: ' + text)
      assert.ok(text.includes('network down'), 'the reason must be shown')
      for (const cleanup of runtime.cleanups.splice(0)) cleanup()
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

await test('with auto-archive off the favorites UI stays hidden', async () => {
  await withGlobals(async () => {
    const { runtime, state } = await mount({ fetch: { favorites: ['fav-1'], settings: { autoArchive: false, autoArchiveDays: 7, autoArchiveExclude: '', loopGuard: true } } })
    const contribution = state.menuContributions[0]
    assert.deepEqual(contribution.resolve({ sessionId: 'fav-1', displayTitle: 'One' }), [], 'no favorite action without auto-archive')

    const trailing = state.registrations.find((row) => row.options.name === 'sidebar.session.row.trailing')
    assert.equal(trailing.component({ sessionId: 'fav-1' }), null, 'no ★ without auto-archive')

    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    const text = textOf(await renderStable(section.component, {}, runtime)).join(' | ')
    assert.ok(!text.includes('收藏 (1)'), 'the favorites block must be hidden, got: ' + text)
    assert.ok(text.includes('收藏属于自动归档的一部分'), 'the page explains why favorites are off')
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('turning auto-archive on reveals the favorites block before saving', async () => {
  await withGlobals(async () => {
    const { runtime, state } = await mount({ fetch: { favorites: ['fav-1'], settings: { autoArchive: false, autoArchiveDays: 7, autoArchiveExclude: '', loopGuard: true } } })
    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    const tree = await renderStable(section.component, {}, runtime)
    const checkbox = findAll(tree, 'input').filter((node) => node.props.type === 'checkbox')[0]
    checkbox.props.onChange({ target: { checked: true } })
    const after = await renderStable(section.component, {}, runtime)
    const text = textOf(after).join(' | ')
    assert.ok(text.includes('收藏 (1)'), 'the favorites block appears with the switch, got: ' + text)
    assert.ok(text.includes('fav-1'), 'the stored id is listed again')
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('saving auto-archive off takes the favorites UI away immediately', async () => {
  await withGlobals(async () => {
    const { runtime, state } = await mount({ fetch: { favorites: ['fav-1'], settings: ARCHIVE_ON } })
    const contribution = state.menuContributions[0]
    assert.equal(contribution.resolve({ sessionId: 'fav-1', displayTitle: 'One' }).length, 1)

    const section = state.registrations.find((row) => row.options.name === 'settings.section')
    let tree = await renderStable(section.component, {}, runtime)
    findAll(tree, 'input').filter((node) => node.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    tree = await renderStable(section.component, {}, runtime)
    const save = findAll(tree, 'button').find((node) => textOf(node).join('') === '保存')
    assert.ok(save !== undefined, 'the save button must be labelled 保存')
    await save.props.onClick()
    await new Promise((done) => setTimeout(done, 0))

    assert.deepEqual(contribution.resolve({ sessionId: 'fav-1', displayTitle: 'One' }), [], 'the menu item disappears after saving the switch off')
    const trailing = state.registrations.find((row) => row.options.name === 'sidebar.session.row.trailing')
    assert.equal(trailing.component({ sessionId: 'fav-1' }), null, 'the ★ disappears too')
    for (const cleanup of runtime.cleanups.splice(0)) cleanup()
  })
})

await test('without a contextMenus service the rest of the UI still registers', async () => {
  await withGlobals(async () => {
    const { state } = await mount({ withMenus: false, fetch: {} })
    assert.equal(state.menuContributions.length, 0, 'no menu without the service')
    assert.ok(state.injections.includes('settings.section'), 'the settings page still registers')
    assert.ok(state.injections.includes('sidebar.session.row.trailing'), 'the row star still registers')
  })
})

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)