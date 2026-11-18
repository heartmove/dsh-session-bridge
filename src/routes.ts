/**
 * 收藏集合的同源 HTTP 面：浏览器半（`client/index.js`）用它读写收藏，
 * 与 host 的 `session_bridge_favorite` 工具共用同一个 `FavoritesStore`。
 *
 * 为什么需要这条路由：DSH 的静态 Client 插件没有到达自定义 host 服务的 RPC 通道
 * （`host.call` 只属于动态 package，`ctx.remote.*` 只暴露官方生成的命名空间），
 * 而收藏状态必须由 host 持久化、又要在每次渲染会话行时读取。最小可用的复用点
 * 就是 `ctx.webServer.register()` 注册一条同源 JSON 路由。
 *
 * 安全边界与官方路由一致：
 *  - 有 `connection` 服务时走 `requestRejection(req)`（Origin/Host 信任 + 浏览器 cookie）；
 *  - 没有该服务（非 Web 组合）时只放行回环地址，绝不对局域网开放；
 *  - body 限 4 KiB、只接受 JSON、响应 `no-store`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FavoritesStore } from './favorites.ts'

/** 收藏路由的绝对路径（浏览器半按同源相对路径拼它）。 */
export const FAVORITES_ROUTE_PATH = '/session-bridge/favorites'
/** 插件设置路由的绝对路径（设置页读写 autoArchive* / loopGuard）。 */
export const SETTINGS_ROUTE_PATH = '/session-bridge/settings'

const MAX_BODY_BYTES = 4 * 1024

interface IncomingLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

interface OutgoingLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function sendJson(res: OutgoingLike, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

function headerOf(req: IncomingLike, name: string): string {
  const raw = req.headers[name]
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
}

/** 回环地址判定（无 connection 服务时的唯一放行面）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string' || address === '') return false
  const value = address.toLowerCase()
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

function rejectionOf(host: unknown, req: IncomingLike): number | undefined {
  const bag = host as { get?: (name: string) => unknown; connection?: unknown }
  const connection = (bag.get?.('connection') ?? bag.connection) as { requestRejection?: (request: unknown) => unknown } | undefined
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(req)
      return typeof rejection === 'number' ? rejection : undefined
    } catch {
      return 403
    }
  }
  return isLoopbackAddress(req.socket?.remoteAddress) ? undefined : 403
}

async function readJsonBody(req: IncomingLike, limit: number = MAX_BODY_BYTES): Promise<unknown> {
  if (typeof req[Symbol.asyncIterator] !== 'function') return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * 一条请求的完整处理（导出供测试直接驱动，无需真实 HTTP server）。
 * @returns 已写出的 HTTP 状态码。
 */
export async function handleFavoritesRequest(
  host: unknown,
  favorites: FavoritesStore,
  req: IncomingLike,
  res: OutgoingLike,
): Promise<number> {
  const rejection = rejectionOf(host, req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return rejection
  }
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    sendJson(res, 200, await favorites.snapshot())
    return 200
  }
  if (method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, POST')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return 405
  }
  if (headerOf(req, 'content-type').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
    return 415
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error: unknown) {
    sendJson(res, 400, {
      code: 'invalid-body',
      message: error instanceof Error ? error.message : String(error),
    })
    return 400
  }
  const bag = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const sessionId = typeof bag.sessionId === 'string' ? bag.sessionId.trim() : ''
  if (sessionId === '') {
    sendJson(res, 400, { code: 'invalid-session-id', message: 'sessionId must be a non-empty string' })
    return 400
  }
  if (bag.favorite !== undefined && typeof bag.favorite !== 'boolean') {
    sendJson(res, 400, { code: 'invalid-favorite', message: 'favorite must be a boolean' })
    return 400
  }
  const favorite = bag.favorite !== false
  const snapshot = await favorites.set(sessionId, favorite)
  sendJson(res, 200, { ...snapshot, sessionId, favorite })
  return 200
}

/** 把路由挂到一个已持有 `webServer` 的 context 上（effect 生命周期内有效）。 */
function attachRoute(host: unknown, definitions: readonly RouteDefinition[]): void {
  const bag = host as {
    webServer?: { register?: (route: unknown) => unknown }
    effect?: (callback: () => unknown, label?: string) => unknown
  }
  const server = bag.webServer
  if (server === undefined || typeof server.register !== 'function') return
  const effect = bag.effect
  for (const definition of definitions) {
    const route = {
      kind: 'exact' as const,
      path: definition.path,
      handler: (req: IncomingLike, res: OutgoingLike): void => {
        void definition.handle(req, res).catch((error: unknown) => {
          if (!res.statusCode || res.statusCode === 200) {
            sendJson(res, 500, { code: 'internal-error', message: error instanceof Error ? error.message : String(error) })
          }
        })
      },
    }
    if (typeof effect === 'function') {
      effect(() => server.register?.(route), 'dsh-session-bridge: ' + definition.path)
    } else {
      server.register(route)
    }
  }
}

/** 一条要挂载的路由：路径 + 处理函数。 */
interface RouteDefinition {
  path: string
  handle(req: IncomingLike, res: OutgoingLike): Promise<number>
}

/** 设置页面读到的一份配置快照（全部是 volatile 字段的当前生效值）。 */
export interface PluginSettingsSnapshot {
  autoArchive: boolean
  autoArchiveDays: number
  autoArchiveExclude: string
  loopGuard: boolean
}

/** 设置路由的读写能力：读走 volatile 引用，写走 configEditor（与 /cot-loop 同一条路径）。 */
export interface SettingsRouteDeps {
  read(): PluginSettingsSnapshot
  write(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }>
  /** 本部署是否接受写回（没有 configEditor 时设置页只能展示）。 */
  writable(): boolean
}

const SETTINGS_BODY_LIMIT = 8 * 1024

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 设置路由：设置页的「会话归档」页读写插件配置。
 *
 * 只接受四个 volatile 字段；非法值整个请求拒绝（400），不做"部分成功"，
 * 否则设置页的保存按钮无法判断哪一项没写进去。写回失败（例如被更高层配置覆盖）
 * 返回 200 + `ok: false`，因为那不是请求格式问题，UI 要显示原因。
 */
export async function handleSettingsRequest(
  host: unknown,
  deps: SettingsRouteDeps,
  req: IncomingLike,
  res: OutgoingLike,
): Promise<number> {
  const rejection = rejectionOf(host, req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return rejection
  }
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    sendJson(res, 200, { settings: deps.read(), writable: deps.writable() })
    return 200
  }
  if (method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, POST')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return 405
  }
  if (headerOf(req, 'content-type').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
    return 415
  }
  let body: unknown
  try {
    body = await readJsonBody(req, SETTINGS_BODY_LIMIT)
  } catch (error: unknown) {
    sendJson(res, 400, { code: 'invalid-body', message: error instanceof Error ? error.message : String(error) })
    return 400
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { code: 'invalid-body', message: 'body must be a JSON object' })
    return 400
  }
  const input = body as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (input.autoArchive !== undefined) {
    if (typeof input.autoArchive !== 'boolean') {
      sendJson(res, 400, { code: 'invalid-auto-archive', message: 'autoArchive must be a boolean' })
      return 400
    }
    patch.autoArchive = input.autoArchive
  }
  if (input.loopGuard !== undefined) {
    if (typeof input.loopGuard !== 'boolean') {
      sendJson(res, 400, { code: 'invalid-loop-guard', message: 'loopGuard must be a boolean' })
      return 400
    }
    patch.loopGuard = input.loopGuard
  }
  if (input.autoArchiveDays !== undefined) {
    const days = clampInt(input.autoArchiveDays, 1, 3650)
    if (days === undefined) {
      sendJson(res, 400, { code: 'invalid-auto-archive-days', message: 'autoArchiveDays must be a number' })
      return 400
    }
    patch.autoArchiveDays = days
  }
  if (input.autoArchiveExclude !== undefined) {
    if (typeof input.autoArchiveExclude !== 'string' || input.autoArchiveExclude.length > 4096) {
      sendJson(res, 400, { code: 'invalid-auto-archive-exclude', message: 'autoArchiveExclude must be a string of at most 4096 characters' })
      return 400
    }
    patch.autoArchiveExclude = input.autoArchiveExclude
  }
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { code: 'empty-patch', message: 'no supported field was supplied' })
    return 400
  }
  const written = await deps.write(patch)
  sendJson(res, 200, { ok: written.ok, message: written.message, settings: deps.read(), writable: deps.writable() })
  return 200
}

/**
 * 注册收藏与设置两条同源路由。
 *
 * `webServer` 是可选能力：在 headless / CLI 组合里不存在，此时静默跳过
 * （收藏仍可由 `session_bridge_favorite` 工具维护，自动归档照常读取；设置页在
 * 没有 Web UI 时也没有意义）。
 */
export function registerBridgeRoutes(
  ctx: Context,
  deps: { favorites: FavoritesStore; settings?: SettingsRouteDeps },
): void {
  const definitions: RouteDefinition[] = [
    {
      path: FAVORITES_ROUTE_PATH,
      handle: (req, res) => handleFavoritesRequest(ctx, deps.favorites, req, res),
    },
  ]
  const settings = deps.settings
  if (settings !== undefined) {
    definitions.push({
      path: SETTINGS_ROUTE_PATH,
      handle: (req, res) => handleSettingsRequest(ctx, settings, req, res),
    })
  }
  const candidate = ctx as unknown as {
    inject?: (names: string[], callback: (child: unknown) => void) => unknown
    webServer?: unknown
  }
  if (typeof candidate.inject === 'function') {
    try {
      candidate.inject(['webServer'], (child) => {
        attachRoute(child, definitions)
      })
      return
    } catch {
      // 注入失败时退化成同步探测（测试桩/旧宿主）。
    }
  }
  if (candidate.webServer !== undefined) attachRoute(ctx, definitions)
}