/**
 * 会话收藏（favorite）：与“置顶（pin）”无关的独立标记。
 *
 * 设计边界（用户明确要求）：
 *  - **收藏不置顶**：不调用 `workspaceRegistry.pinSession`，不改变任何分组排序；
 *  - 收藏只做两件事：在会话行上显示 ★、让自动归档跳过该会话；
 *  - 状态必须跨重启保留，且 UI（浏览器半）与工具（host 半）读写同一份数据。
 *
 * 存储放在 `~/.dsh/session-bridge-favorites.json`，与 bridge 的会话登记表同目录：
 *
 *   { "sessionIds": ["..."], "updatedAt": 1760000000000 }
 *
 * 读写策略：
 *  - 首次访问惰性加载；文件缺失 → 空集；损坏 → 空集 + 一条 warn（不阻塞插件）；
 *  - 内存 Set 的插入顺序即返回顺序（最新收藏在尾部）；
 *  - 所有落盘进一条串行队列：连续 toggle 不会互相覆盖，也不会产生半截文件；
 *  - 写失败只记录日志：收藏是辅助信息，不该让归档或工具整体失败。
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 收藏集合的一份快照（lossless JSON 友好）。 */
export interface FavoritesSnapshot {
  /** 按收藏顺序排列的 session id（最新收藏在尾部）。 */
  sessionIds: string[]
  /** 最后一次成功变更的时间戳（毫秒）；没有变更时为 0。 */
  updatedAt: number
}

/** 收藏变更的监听签名（HTTP 路由/测试用；不需要实时推送）。 */
export type FavoritesListener = (snapshot: FavoritesSnapshot) => void

const FAVORITES_FILE_NAME = 'session-bridge-favorites.json'

/** 解析已落盘 JSON：支持当前对象形状与早期裸数组形状。 */
function parseStored(raw: string): { ids: string[]; updatedAt: number } {
  const parsed = JSON.parse(raw) as unknown
  const bag = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const source = Array.isArray(parsed) ? parsed : bag.sessionIds
  const ids: string[] = []
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string' && entry.trim() !== '' && !ids.includes(entry)) ids.push(entry)
    }
  }
  const updatedAt = typeof bag.updatedAt === 'number' && Number.isFinite(bag.updatedAt) ? bag.updatedAt : 0
  return { ids, updatedAt }
}

export class FavoritesStore {
  private readonly ids = new Set<string>()
  private readonly listeners = new Set<FavoritesListener>()
  private readonly filePath: string
  private updatedAt = 0
  private loaded = false
  private loading: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string = dshHomePath(FAVORITES_FILE_NAME)) {
    this.filePath = filePath
  }

  /** 加载一次（幂等，并发调用共享同一个 promise）。 */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loading !== undefined) return this.loading
    this.loading = readFile(this.filePath, 'utf8')
      .then((raw) => {
        const stored = parseStored(raw)
        for (const id of stored.ids) this.ids.add(id)
        this.updatedAt = stored.updatedAt
      })
      .catch((error: unknown) => {
        const code = (error as { code?: string } | null)?.code
        if (code !== 'ENOENT') {
          console.warn(
            '[dsh-session-bridge] favorites load failed:',
            error instanceof Error ? error.message : String(error),
          )
        }
      })
      .finally(() => {
        this.loaded = true
        this.loading = undefined
      })
    return this.loading
  }

  /** 等待首次加载完成。 */
  ready(): Promise<void> {
    return this.load()
  }

  /** 当前收藏快照。 */
  async snapshot(): Promise<FavoritesSnapshot> {
    await this.load()
    return { sessionIds: [...this.ids], updatedAt: this.updatedAt }
  }

  /** 收藏 id 列表（收藏顺序，最新在尾部）。 */
  async list(): Promise<string[]> {
    await this.load()
    return [...this.ids]
  }

  /** 某个会话是否已收藏。 */
  async has(sessionId: string): Promise<boolean> {
    await this.load()
    return this.ids.has(sessionId)
  }

  /**
   * 收藏 / 取消收藏（幂等）。
   * @param sessionId 目标会话；空字符串拒绝。
   * @param favorite true 收藏（默认），false 取消。
   */
  async set(sessionId: string, favorite = true): Promise<FavoritesSnapshot> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') throw new Error('invalid sessionId: expected a non-empty string')
    await this.load()
    const existed = this.ids.has(id)
    if (favorite && !existed) {
      this.ids.add(id)
      this.updatedAt = Date.now()
      await this.persist()
      this.emit()
    } else if (!favorite && existed) {
      this.ids.delete(id)
      this.updatedAt = Date.now()
      await this.persist()
      this.emit()
    }
    return this.snapshot()
  }

  /** 订阅变更（返回取消订阅函数）。 */
  subscribe(listener: FavoritesListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const snapshot: FavoritesSnapshot = { sessionIds: [...this.ids], updatedAt: this.updatedAt }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // 监听方异常不影响收藏写入。
      }
    }
  }

  /** 串行落盘：前一次写失败不会卡住后续写入。 */
  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const payload = JSON.stringify({ sessionIds: [...this.ids], updatedAt: this.updatedAt }, null, 2)
      await writeFile(this.filePath, payload, 'utf8')
    }).catch((error: unknown) => {
      console.warn(
        '[dsh-session-bridge] favorites write failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
    return this.writeQueue
  }
}