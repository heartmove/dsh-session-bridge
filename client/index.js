/**
 * dsh-session-bridge 浏览器半（Client bundle）。
 *
 * 三块 UI，全部围绕"会话收藏（★，不置顶）+ 自动归档"：
 *  1. 工作区会话的上下文菜单（`ctx.contextMenus`，target `session`）：收藏 / 取消收藏，
 *     与内置项（置顶 / 重命名 / 分叉 / 归档）同一条渲染路径与同一套图标槽；
 *  2. 会话行尾的 ★（`sidebar.session.row.trailing`，时间标签之后、官方图钉之前）；
 *  3. 设置里的独立标签页（`settings.section` + `settings.section.icon`）：自动归档开关、
 *     天数、保留名单，以及思维链循环总开关和收藏列表。
 *
 * 数据经同源 HTTP 路由（`/session-bridge/favorites`、`/session-bridge/settings`）与 host
 * 的 FavoritesStore / 插件配置同步；`session_bridge_favorite` 工具写的是同一份收藏集合。
 *
 * 两条实现纪律（都是为了"再也不会整页空白"）：
 *  - 组件依赖（收藏 store、翻译函数）由 apply **闭包**传入，不靠 slot 的 inject 面；
 *  - hooks 与渲染分离：hooks 在固定位置无条件调用，渲染体包在 try/catch 里，
 *    任何渲染异常都会显示成页面上的错误文本而不是白屏。
 *
 * 构建形态与官方 Client 插件一致：由 `window.__ModuleLoader__` 注册一个惰性工厂，
 * React 从模块表 `require('react')` 取得，不打包第二份 React。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与 host 的 locale namespace 保持一致。 */
    const NS = 'dsh-session-bridge'
    /** 与 host 的 FAVORITES_ROUTE_PATH / SETTINGS_ROUTE_PATH 保持一致（同源相对路径）。 */
    const FAVORITES_PATH = 'session-bridge/favorites'
    const SETTINGS_PATH = 'session-bridge/settings'
    /** 设置页在导航里的 id（图标注册必须用同一个 id）。 */
    const SECTION_ID = 'dsh-session-bridge'
    /** 图标 key（注册到 `contextMenu.icon` 槽位，与内置 workspace.* 图标并列）。 */
    const ICON_STAR_OUTLINE = 'session-bridge.star-outline'
    const ICON_STAR_FILL = 'session-bridge.star-fill'

    const en = {
      favorite: 'Favorite',
      unfavorite: 'Remove favorite',
      favorited: 'Favorited',
      section: 'Session archive',
      title: 'Session archive & favorites',
      description: 'Favorited sessions keep a ★ and are never auto-archived. When auto-archive is on, the plugin archives stale sessions once an hour.',
      descriptionOff: 'Favorites belong to auto-archive: turn it on and favorited sessions keep a ★ and are skipped by every archive pass.',
      autoArchive: 'Auto-archive stale sessions',
      autoArchiveHint: 'Runs once an hour. Off by default.',
      days: 'Archive sessions inactive for (days)',
      daysHint: 'Last activity comes from the session log; exactly this many days is left alone.',
      exclude: 'Never auto-archive these session ids',
      excludeHint: 'Comma or whitespace separated. Favorites are excluded automatically.',
      loopGuard: 'Interrupt chain-of-thought loops',
      loopGuardHint: 'Same switch as /cot-loop and the plugin settings form.',
      favorites: 'Favorites',
      favoritesEmpty: 'No favorited session yet. Use the session menu (…) to favorite one.',
      remove: 'Remove',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Settings saved — the next archive pass uses them.',
      loading: 'Loading…',
      readOnly: 'This deployment stores settings read-only.',
      loadFailed: 'Could not load settings',
      saveFailed: 'The deployment did not accept these values',
      invalidDays: 'Enter a whole number between 1 and 3650.',
      renderFailed: 'The settings page failed to render',
    }
    const zh = {
      favorite: '收藏',
      unfavorite: '取消收藏',
      favorited: '已收藏',
      section: '会话归档',
      title: '会话归档与收藏',
      description: '收藏的会话会显示 ★，且永远不会被自动归档。开启自动归档后，插件每小时归档一次长期未活动的会话。',
      descriptionOff: '收藏属于自动归档的一部分：开启后，被收藏的会话会显示 ★ 并永久跳过自动归档。',
      autoArchive: '自动归档长期未活动的会话',
      autoArchiveHint: '每小时执行一次；默认关闭。',
      days: '超过多少天未活动就归档',
      daysHint: '“最后活动”取自会话日志；正好这么多天不动它。',
      exclude: '永不自动归档的会话 id',
      excludeHint: '逗号或空白分隔；收藏的会话已自动排除。',
      loopGuard: '思维链陷入循环时自动中断',
      loopGuardHint: '与 /cot-loop 命令、插件设置表单是同一个开关。',
      favorites: '收藏',
      favoritesEmpty: '还没有收藏的会话。在会话行菜单（…）里收藏一个。',
      remove: '取消收藏',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，下一轮归档即按新设置执行。',
      loading: '加载中…',
      readOnly: '本部署的设置为只读。',
      loadFailed: '读取设置失败',
      saveFailed: '本部署没有接受这些值',
      invalidDays: '请填 1–3650 之间的整数。',
      renderFailed: '设置页渲染失败',
    }

    /** 解析同源地址：兼容 DSH 挂在子路径下的部署。 */
    function endpointOf(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
        ? document.baseURI
        : (typeof location !== 'undefined' ? location.origin + '/' : 'http://127.0.0.1/')
      return new URL(path, base).toString()
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return {}
      }
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * 收藏集合的浏览器侧缓存。
     *
     * 语义：**服务端为准** —— 只有 POST 成功才更新本地集合；失败保持原状并打日志。
     * 不做轮询：收藏只在本页操作时变化；页面加载时拉一次即可。
     */
    function createStore() {
      let ids = new Set()
      let loaded = false
      let version = 0
      /**
       * 自动归档开关（设置页与 `/session-bridge/settings` 的当前值）。
       *
       * 收藏的唯一作用是"显示 ★ + 跳过自动归档"，所以自动归档关闭时收藏整套 UI
       * （菜单项、行尾 ★、设置页的收藏区）都不出现：一个不产生任何效果的开关
       * 只会让界面变脏。收藏数据本身保留，重新开启自动归档就原样回来。
       */
      let autoArchive = false
      const listeners = new Set()

      function notify() {
        version += 1
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // 单个订阅者异常不影响其余订阅者。
          }
        }
      }

      function setAutoArchive(value) {
        const next = value === true
        if (next === autoArchive) return
        autoArchive = next
        notify()
      }

      function applySnapshot(data) {
        const list = data && Array.isArray(data.sessionIds) ? data.sessionIds : []
        ids = new Set(list.map(String))
        loaded = true
        notify()
      }

      const store = {
        get loaded() {
          return loaded
        },
        /** 自动归档是否开启：收藏 UI 的总闸门（关闭时菜单项、★、收藏区都不出现）。 */
        get autoArchive() {
          return autoArchive
        },
        setAutoArchive,
        has(sessionId) {
          return ids.has(String(sessionId))
        },
        list() {
          return [...ids]
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** 供 `ctx.contextMenus` 的 `observe` 使用：同一份变更的可观察快照。 */
        snapshot() {
          return { getSnapshot: () => version, subscribe: store.subscribe }
        },
        /** 收藏集合与自动归档开关一起拉一次（两份都失败也不影响另一份）。 */
        async load() {
          await Promise.all([store.loadFavorites(), store.loadSettings()])
        },
        async loadFavorites() {
          try {
            const response = await fetch(endpointOf(FAVORITES_PATH), {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            applySnapshot(await readJson(response))
          } catch (error) {
            console.error('[dsh-session-bridge] favorites load failed', error)
          }
        },
        /**
         * 读一次设置，只为拿 `autoArchive`（收藏 UI 的显示条件）。
         *
         * 失败时保持"关闭"：自动归档默认关闭，把读不到当成开启会凭空亮出一套无效的收藏 UI。
         */
        async loadSettings() {
          try {
            const response = await fetch(endpointOf(SETTINGS_PATH), {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const data = await readJson(response)
            const settings = data !== null && typeof data === 'object' && data.settings !== null && typeof data.settings === 'object'
              ? data.settings
              : {}
            setAutoArchive(settings.autoArchive === true)
          } catch (error) {
            console.error('[dsh-session-bridge] settings load failed', error)
          }
        },
        async set(sessionId, favorite) {
          try {
            const response = await fetch(endpointOf(FAVORITES_PATH), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: String(sessionId), favorite: favorite === true }),
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            applySnapshot(await readJson(response))
            return true
          } catch (error) {
            console.error('[dsh-session-bridge] favorite update failed', error)
            return false
          }
        },
        async toggle(sessionId) {
          return store.set(sessionId, !store.has(sessionId))
        },
      }
      return store
    }

    /** 订阅收藏集合，变化时让宿主组件重渲染。 */
    function useFavorites(store) {
      const [, setVersion] = React.useState(0)
      React.useEffect(
        () => store.subscribe(() => setVersion((value) => value + 1)),
        [store],
      )
    }

    // ---------- 图标（与内置菜单图标同为 14px 线性图标） ----------

    function starPath(filled) {
      return filled
        ? 'M8 1.6l1.79 3.63 4.01.58-2.9 2.83.68 3.99L8 10.75l-3.58 1.88.68-3.99-2.9-2.83 4.01-.58z'
        : 'M8 2.7l1.32 2.68 2.96.43-2.14 2.09.5 2.95L8 9.47l-2.64 1.38.5-2.95-2.14-2.09 2.96-.43z'
    }

    function starIcon(filled) {
      return function StarIcon() {
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            fill: filled ? 'currentColor' : 'none',
            stroke: 'currentColor',
            strokeWidth: filled ? 0 : 1.2,
            'aria-hidden': true,
            style: { display: 'block' },
          },
          h('path', { d: starPath(filled) }),
        )
      }
    }

    /** 设置导航图标：星形 + 一条归档线，尺寸由 owner 的 `size` 决定。 */
    function SectionIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: starPath(false) }),
        h('path', { d: 'M3 13.5h10', strokeLinecap: 'round' }),
      )
    }

    /**
     * 会话菜单里的“收藏 / 取消收藏”（由 `ctx.contextMenus` 渲染，与内置项同款）。
     *
     * `t` 在 resolve 时现取：菜单每次打开都会重新 resolve，所以语言切换后文案会跟着变。
     */
    function favoriteActions(favorites, translate, target) {
      // 自动归档关闭 → 收藏不产生任何效果，菜单项直接不出现（不是置灰）。
      if (favorites.autoArchive !== true) return []
      const t = translate()
      const sessionId = String(target.sessionId)
      const favorited = favorites.has(sessionId)
      return [{
        id: 'toggle',
        label: t(favorited ? 'unfavorite' : 'favorite'),
        icon: { key: favorited ? ICON_STAR_FILL : ICON_STAR_OUTLINE },
        run: () => favorites.set(sessionId, !favorited),
      }]
    }

    /**
     * 行尾的 ★：仅收藏时出现（官方置顶图钉是另一个图标，二者互不影响）。
     *
     * 依赖经**闭包**传入而不是靠 slot 的 inject 面：组件只从 owner 拿 `sessionId`，
     * 这样即使某个宿主版本不给组件注入自定 props，★ 也照常渲染。
     */
    function makeFavoriteStar(favorites, translate) {
      return function FavoriteStar(props) {
        const sessionId = props && props.sessionId
        useFavorites(favorites)
        // 收藏只是一个"跳过自动归档"的标记：该功能关闭时 ★ 也不显示。
        if (favorites.autoArchive !== true) return null
        if (sessionId === undefined || !favorites.has(sessionId)) return null
        return h(
          'span',
          {
            title: translate()('favorited'),
            'aria-hidden': true,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--dsw-alias-state-warn-primary, #d99a00)',
              marginInlineStart: 2,
            },
          },
          h(starIcon(true), {}),
        )
      }
    }

    // ---------- 设置页 ----------

    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 32,
      padding: '4px 8px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
    }

    const rowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '12px 0',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
    }

    const labelStyle = { fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' }
    const hintStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }

    function buttonStyle(primary) {
      return {
        minHeight: 30,
        padding: '4px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        font: 'inherit',
        border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l2, rgba(128,128,128,.4))'),
        background: primary ? 'var(--dsw-alias-brand-primary, #247bbf)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary, inherit)',
      }
    }

    function field(key, children, title, hint) {
      return h('div', { key, style: rowStyle }, [
        h('label', { key: 'label', style: labelStyle }, title),
        ...children,
        hint === undefined ? null : h('div', { key: 'hint', style: hintStyle }, hint),
      ])
    }

    function checkRow(key, checked, disabled, label, onChange) {
      return h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } }, [
        h('input', { key: 'cb', type: 'checkbox', checked, disabled, onChange }),
        h('span', { key: 'text' }, label),
      ])
    }

    /** 设置快照里的自动归档开关（缺字段/形状异常一律按关闭）。 */
    function autoArchiveOf(settings) {
      return settings !== null && typeof settings === 'object' && settings.autoArchive === true
    }

    /**
     * 「会话归档」设置页：自动归档三项 + 循环总开关 + 收藏列表。
     *
     * 收藏区只在自动归档开启时出现（`draft.autoArchive === true`）：关闭时收藏既不显示
     * ★ 也不会被归档逻辑读到，留在页面上只会是一个没有效果的开关。看着 checkbox 现改现显，
     * 不用先保存 —— 保存成功后还会把结果写回 `favorites` store，让菜单项与 ★ 立即跟随。
     *
     * `favorites` 与 `translate` 由 apply **闭包**传入，不依赖 slot 的 inject 面。
     */
    function makeSettingsPage(favorites, translate) {
      /** 所有 hooks 集中在这里：渲染体抛出异常也不会打乱 hooks 顺序。 */
      function useSettingsView() {
        const [state, setState] = React.useState({ status: 'loading', settings: undefined, writable: true, error: undefined, notice: undefined })
        const [draft, setDraft] = React.useState(undefined)
        useFavorites(favorites)

        React.useEffect(() => {
          let cancelled = false
          void (async () => {
            try {
              const response = await fetch(endpointOf(SETTINGS_PATH), {
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              })
              if (!response.ok) throw new Error('HTTP ' + response.status)
              const data = await readJson(response)
              if (cancelled) return
              setState({ status: 'ready', settings: data.settings, writable: data.writable !== false, error: undefined, notice: undefined })
              setDraft(data.settings)
              // 设置页读到的开关就是收藏 UI 的闸门：打开页面即可让菜单项 / ★ 与之一致。
              favorites.setAutoArchive(autoArchiveOf(data.settings))
            } catch (error) {
              if (!cancelled) setState({ status: 'error', settings: undefined, writable: true, error: errorText(error), notice: undefined })
            }
          })()
          return () => {
            cancelled = true
          }
        }, [])

        const update = (patch) => setDraft((current) => ({ ...(current ?? {}), ...patch }))

        const save = async (t) => {
          if (draft === undefined) return
          const days = Number(draft.autoArchiveDays)
          if (!Number.isFinite(days) || days < 1 || days > 3650) {
            setState((current) => ({ ...current, error: t('invalidDays'), notice: undefined }))
            return
          }
          setState((current) => ({ ...current, status: 'saving', error: undefined, notice: undefined }))
          try {
            const response = await fetch(endpointOf(SETTINGS_PATH), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({
                autoArchive: draft.autoArchive === true,
                autoArchiveDays: Math.round(days),
                autoArchiveExclude: String(draft.autoArchiveExclude ?? ''),
                loopGuard: draft.loopGuard === true,
              }),
            })
            const data = await readJson(response)
            if (!response.ok) throw new Error(data.message || 'HTTP ' + response.status)
            setState({
              status: 'ready',
              settings: data.settings,
              writable: data.writable !== false,
              error: data.ok === false ? data.message : undefined,
              notice: data.ok === false ? undefined : t('saved'),
            })
            if (data.settings !== undefined) setDraft(data.settings)
            // 保存后立即卸下 / 挂上收藏 UI（菜单项、★、收藏区），不必重开页面。
            favorites.setAutoArchive(autoArchiveOf(data.settings))
          } catch (error) {
            setState((current) => ({ ...current, status: 'ready', error: t('saveFailed') + ': ' + errorText(error), notice: undefined }))
          }
        }

        return { state, draft, update, save }
      }

      /** 纯渲染：可被 try/catch 包住，异常显示为页面文本。 */
      function renderSettings(view, t) {
        // 旧版 render 与本函数之间的改动：把闭包里的调用方固定下来（无副作用）。
        void 0
        const { state, draft, update, save } = view
        const header = h('div', { key: 'header' }, [
          h('h2', { key: 'title', style: { margin: '0 0 6px', fontSize: 18, color: 'var(--dsw-alias-label-primary, inherit)' } }, t('title')),
          h('p', { key: 'desc', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } },
            t(draft !== undefined && draft.autoArchive === true ? 'description' : 'descriptionOff')),
        ])

        if (state.status === 'loading') {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
            header,
            h('div', { key: 'loading', style: hintStyle }, t('loading')),
          ])
        }
        if (state.status === 'error' || draft === undefined) {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
            header,
            h('div', { key: 'error', style: { color: 'var(--dsw-alias-state-error-primary, #c33)', fontSize: 13 } },
              t('loadFailed') + ': ' + String(state.error === undefined ? '' : state.error)),
          ])
        }

        // 收藏区只在自动归档开启时渲染：关闭时它既不显示 ★，也不会被归档逻辑读到。
        const favoritesVisible = draft.autoArchive === true
        const list = favoritesVisible ? favorites.list() : []
        const disabled = state.status === 'saving' || state.writable === false

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 620 } }, [
          header,
          state.writable === false
            ? h('div', { key: 'ro', style: { ...hintStyle, marginTop: 8 } }, t('readOnly'))
            : null,

          field('archive', [
            checkRow('switch', draft.autoArchive === true, disabled, t('autoArchive'),
              (event) => update({ autoArchive: event.target.checked })),
          ], t('autoArchive'), t('autoArchiveHint')),

          field('days', [
            h('input', {
              key: 'days',
              type: 'number',
              min: 1,
              max: 3650,
              step: 1,
              value: draft.autoArchiveDays === undefined ? 7 : draft.autoArchiveDays,
              disabled,
              style: { ...inputStyle, maxWidth: 160 },
              onChange: (event) => update({ autoArchiveDays: event.target.value === '' ? '' : Number(event.target.value) }),
            }),
          ], t('days'), t('daysHint')),

          field('exclude', [
            h('textarea', {
              key: 'exclude',
              rows: 2,
              value: draft.autoArchiveExclude === undefined ? '' : draft.autoArchiveExclude,
              disabled,
              placeholder: 'session-id-1, session-id-2',
              style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
              onChange: (event) => update({ autoArchiveExclude: event.target.value }),
            }),
          ], t('exclude'), t('excludeHint')),

          field('loop', [
            checkRow('switch', draft.loopGuard === true, disabled, t('loopGuard'),
              (event) => update({ loopGuard: event.target.checked })),
          ], t('loopGuard'), t('loopGuardHint')),

          h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12 } }, [
            h('button', {
              key: 'save',
              type: 'button',
              disabled,
              style: buttonStyle(true),
              onClick: () => { void save(t) },
            }, state.status === 'saving' ? t('saving') : t('save')),
            state.error === undefined
              ? null
              : h('span', { key: 'err', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #c33)' } }, state.error),
            state.notice === undefined
              ? null
              : h('span', { key: 'ok', style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2a7)' } }, state.notice),
          ]),

          favoritesVisible
            ? h('div', { key: 'fav', style: { ...rowStyle, marginTop: 4 } }, [
              h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, ...labelStyle } }, [
                h('span', { key: 'icon', style: { display: 'inline-flex', color: 'var(--dsw-alias-state-warn-primary, #d99a00)' } }, h(starIcon(true), {})),
                h('span', { key: 'text' }, t('favorites') + ' (' + String(list.length) + ')'),
              ]),
              list.length === 0
                ? h('div', { key: 'empty', style: hintStyle }, t('favoritesEmpty'))
                : h('div', { key: 'items', style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                  list.map((sessionId) => h('div', {
                    key: sessionId,
                    style: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
                  }, [
                    h('code', { key: 'id', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', overflowWrap: 'anywhere' } }, sessionId),
                    h('button', {
                      key: 'rm',
                      type: 'button',
                      style: buttonStyle(false),
                      onClick: () => { void favorites.set(sessionId, false) },
                    }, t('remove')),
                  ]))),
            ])
            : null,
        ])
      }

      return function SettingsPage() {
        const t = translate()
        const view = useSettingsView()
        try {
          return renderSettings(view, t)
        } catch (error) {
          return h('div', {
            style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #c33)' },
          }, t('renderFailed') + ': ' + errorText(error))
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const favorites = createStore()
        void favorites.load()
        /** 每次都取当前的 locale 绑定（语言切换后组件与菜单自动跟随）。 */
        const translate = () => ctx.locale.bind(NS)
        const FavoriteStar = makeFavoriteStar(favorites, translate)
        const SettingsPage = makeSettingsPage(favorites, translate)

        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'dsh-session-bridge: locale',
        )

        // 1) 会话行尾 ★（时间标签之后、官方图钉之前）。
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'dsh-session-bridge.favorite-star',
          order: 10,
          locale: NS,
        }, FavoriteStar))

        // 2) 会话菜单：走结构化 ctx.contextMenus（与内置项同一条渲染路径）。
        //    服务缺失（旧宿主）时静默跳过，其余 UI 不受影响。
        const registerMenu = (child) => {
          const menus = child.contextMenus
          if (menus === undefined || typeof menus.register !== 'function') return
          const slots = child.slots === undefined ? ctx.slots : child.slots
          child.effect(() => menus.register({
            id: 'dsh-session-bridge.favorite',
            target: 'session',
            // 排在官方归档（600）之前、文件夹显示（500）之后。
            order: 550,
            observe: () => [favorites.snapshot()],
            resolve: (target) => favoriteActions(favorites, translate, target),
          }), 'dsh-session-bridge: favorite menu action')
          // 菜单图标：key 由本插件注册，与内置 workspace.* 图标并列渲染。
          slots.inject('contextMenu.icon', () => {
            const disposers = [
              slots.register({ name: 'contextMenu.icon', key: ICON_STAR_OUTLINE }, starIcon(false)),
              slots.register({ name: 'contextMenu.icon', key: ICON_STAR_FILL }, starIcon(true)),
            ]
            return () => {
              for (const dispose of disposers) dispose()
            }
          })
        }
        const hasContextMenus = () => {
          if (typeof ctx.get === 'function') {
            try {
              return ctx.get('contextMenus') !== undefined
            } catch {
              return false
            }
          }
          return ctx.contextMenus !== undefined
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['contextMenus'], registerMenu)
        } else if (hasContextMenus()) {
          registerMenu(ctx)
        }

        // 3) 设置里的独立标签页 + 导航图标（id 必须与 section 的 id 相同）。
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
        }, SectionIcon))

        ctx.slots.inject('settings.section', () => {
          let dispose = undefined
          const mount = () => ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: 700,
            label: translate()('section'),
            locale: NS,
          }, SettingsPage)
          dispose = mount()
          // 语言切换后重新注册，让导航项拿到新文案（owner 不订阅 locale）。
          const off = typeof ctx.locale.subscribe === 'function'
            ? ctx.locale.subscribe(() => {
              if (dispose !== undefined) dispose()
              dispose = mount()
            })
            : () => {}
          return () => {
            off()
            if (dispose !== undefined) dispose()
          }
        })
      },
    }
  },
})
