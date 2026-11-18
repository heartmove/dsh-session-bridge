/**
 * 会话自动归档：每小时批量归档“长期未活动、且没有被用户保住”的主会话。
 *
 * 规则（用户口径）：
 *  - **特定天数前**：以会话日志文件的最后修改时间（最后活动）为准，缺失时回退 header.createdAt；
 *  - **没有被收藏**：本次新增的收藏标记（favorites.ts）；
 *  - **没有被指定**：配置项 autoArchiveExclude 的保留名单；另外也跳过官方置顶（pin）——
 *    置顶会话一旦被自动归档，registry 会把它的 pin 一并丢弃，违背用户“置顶”的意图；
 *  - 只归档主会话（header.origin !== 'subagent'）、只归档当前不活跃的会话、跳过已归档集合。
 *
 * 调度：插件启动 60 秒后跑首轮，此后每 1 小时一轮；每次 tick 都重新读取 volatile 配置，
 * 所以设置页改“是否自动归档 / 天数 / 名单”后下一轮就生效。
 *
 * 安全边界：unbounded 的归档会把用户历史一次性清空，因此
 *  1) 默认关闭（autoArchive=false）；
 *  2) 不传 stopActivity —— 正在跑的会话由宿主拒绝归档，我们只跳过；
 *  3) 单轮上限 200 个，最旧的优先；
 *  4) 任何单条失败都只记入 report，不中断整轮。
 */
import { stat as statFile } from 'node:fs/promises'
import type { ArchivePolicy } from './config.ts'
import type { FavoritesStore } from './favorites.ts'

/** 一轮归档的间隔：1 小时（用户要求“每一小时执行一次”）。 */
export const AUTO_ARCHIVE_INTERVAL_MS = 3_600_000
/** 插件启动后的首轮延迟：给宿主把持久化列表读热。 */
export const AUTO_ARCHIVE_INITIAL_DELAY_MS = 60_000
/** 单轮最多归档多少个，避免一次性隐藏大量历史会话、也避免长时间占用 domain 写队列。 */
export const AUTO_ARCHIVE_BATCH_LIMIT = 200
/** 一天的毫秒数。 */
export const AUTO_ARCHIVE_DAY_MS = 86_400_000

/** 会话持久化快照里本模块用到的结构面（不引入新的 peer 依赖）。 */
export interface AutoArchiveSnapshot {
  header: {
    id: string
    createdAt?: number
    origin?: string
    [key: string]: unknown
  }
  location?: { path?: string }
  [key: string]: unknown
}

/** 会话持久化服务的最小结构面。 */
export interface AutoArchiveSessionSource {
  list(): Promise<readonly AutoArchiveSnapshot[]>
}

/** workspace registry 的最小结构面。 */
export interface AutoArchiveRegistry {
  readonly archivedSessionIds: readonly string[]
  /** 0.2.x 起提供；旧 harness 缺失时按“没有置顶”处理。 */
  readonly pinnedSessionIds?: readonly string[]
  archiveSession(sessionId: string): Promise<void>
}

/** 自动归档依赖（全部可注入，便于纯测试）。 */
export interface AutoArchiveDeps {
  /** volatile 配置策略：每轮实时读取。 */
  policy: ArchivePolicy
  /** 收藏集合。 */
  favorites: Pick<FavoritesStore, 'list'>
  /** 会话持久化。 */
  persistence: AutoArchiveSessionSource
  /** workspace registry。 */
  workspaceRegistry: AutoArchiveRegistry
  /** 当前 live 的会话 id 集合（活跃会话不归档）。 */
  liveSessionIds: () => Iterable<string>
  /** 计算一个会话的最后活动时间；返回 undefined 表示无法判定。 */
  lastActivityAt?: (snapshot: AutoArchiveSnapshot) => Promise<number | undefined>
  /** 当前时间。 */
  now?: () => number
  /** 日志出口。 */
  log?: (line: string) => void
}

/** 跳过原因的计数键。 */
export type AutoArchiveSkipReason =
  | 'subagent'
  | 'archived'
  | 'favorite'
  | 'exclude'
  | 'pinned'
  | 'live'
  | 'unknown-time'
  | 'not-old-enough'
  | 'active'
  | 'error'

/** 一轮归档的结果（lossless JSON 友好，测试与日志共用）。 */
export interface AutoArchiveReport {
  at: number
  enabled: boolean
  /** 上一轮尚未结束时本轮被跳过。 */
  busy: boolean
  days: number
  scanned: number
  /** 本轮成功归档的 session id。 */
  archived: string[]
  /** 各类跳过原因计数。 */
  skipped: Partial<Record<AutoArchiveSkipReason, number>>
  /** 单条归档失败（含宿主报告 active 的情况）。 */
  failures: Array<{ sessionId: string; message: string }>
  /** 是否因为单轮上限而截断了候选。 */
  truncated: boolean
}

/** 一个待归档候选。 */
export interface AutoArchiveCandidate {
  sessionId: string
  lastActivityAt: number
}

/** 候选选择结果。 */
export interface AutoArchiveSelection {
  candidates: AutoArchiveCandidate[]
  scanned: number
  skipped: Partial<Record<AutoArchiveSkipReason, number>>
  truncated: boolean
}

/** 定时器接口（由插件 ctx 或测试桩提供）。 */
export interface AutoArchiveScheduler {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout?(callback: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

function increment(bag: Partial<Record<AutoArchiveSkipReason, number>>, reason: AutoArchiveSkipReason): void {
  bag[reason] = (bag[reason] ?? 0) + 1
}

/** 安全读取一个集合 getter：旧 harness 缺字段或 getter 抛错时按空集处理。 */
function readIdSet(read: () => readonly string[] | undefined): Set<string> {
  try {
    const value = read()
    return new Set(Array.isArray(value) ? value.map(String) : [])
  } catch {
    return new Set()
  }
}

/** 默认的最后活动时间：日志文件 mtime，缺失/失败回退会话创建时间。 */
export async function defaultLastActivityAt(snapshot: AutoArchiveSnapshot): Promise<number | undefined> {
  const path = snapshot.location?.path
  if (typeof path === 'string' && path !== '') {
    try {
      const info = await statFile(path)
      if (Number.isFinite(info.mtimeMs) && info.mtimeMs > 0) return info.mtimeMs
    } catch {
      // 日志被移走/权限不足：回退 header.createdAt，不把“无法判定”当成“很久没动”。
    }
  }
  const createdAt = snapshot.header.createdAt
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined
}

/**
 * 选出本轮要归档的会话（纯读，不写归档集合）。
 *
 * 阈值语义与 `isStalled` 一致：**严格大于** —— 最后活动“正好 N 天前”不归档，
 * 超过 N 天才归档。
 */
export async function selectAutoArchiveCandidates(
  deps: AutoArchiveDeps,
  at: number = (deps.now ?? Date.now)(),
  limit: number = AUTO_ARCHIVE_BATCH_LIMIT,
): Promise<AutoArchiveSelection> {
  const days = deps.policy.days()
  const cutoff = days * AUTO_ARCHIVE_DAY_MS
  const skipped: Partial<Record<AutoArchiveSkipReason, number>> = {}
  const archived = readIdSet(() => deps.workspaceRegistry.archivedSessionIds)
  const pinned = readIdSet(() => deps.workspaceRegistry.pinnedSessionIds)
  const excluded = deps.policy.exclude()
  let favorite: Set<string>
  try {
    favorite = new Set((await deps.favorites.list()).map(String))
  } catch {
    favorite = new Set()
  }
  let live: Set<string>
  try {
    live = new Set(Array.from(deps.liveSessionIds(), String))
  } catch {
    live = new Set()
  }
  const lastActivityAt = deps.lastActivityAt ?? defaultLastActivityAt

  const rows = await deps.persistence.list()
  const candidates: AutoArchiveCandidate[] = []
  for (const snapshot of rows) {
    const sessionId = typeof snapshot.header?.id === 'string' ? snapshot.header.id : ''
    if (sessionId === '') {
      increment(skipped, 'error')
      continue
    }
    if (snapshot.header.origin === 'subagent') {
      increment(skipped, 'subagent')
      continue
    }
    if (archived.has(sessionId)) {
      increment(skipped, 'archived')
      continue
    }
    if (favorite.has(sessionId)) {
      increment(skipped, 'favorite')
      continue
    }
    if (excluded.has(sessionId)) {
      increment(skipped, 'exclude')
      continue
    }
    if (pinned.has(sessionId)) {
      increment(skipped, 'pinned')
      continue
    }
    if (live.has(sessionId)) {
      increment(skipped, 'live')
      continue
    }
    let last: number | undefined
    try {
      last = await lastActivityAt(snapshot)
    } catch {
      last = undefined
    }
    if (last === undefined || !Number.isFinite(last)) {
      increment(skipped, 'unknown-time')
      continue
    }
    if (at - last > cutoff) {
      candidates.push({ sessionId, lastActivityAt: last })
    } else {
      increment(skipped, 'not-old-enough')
    }
  }

  // 最旧的优先：单轮上限截断时先处理最该走的会话。
  candidates.sort((left, right) => left.lastActivityAt - right.lastActivityAt || left.sessionId.localeCompare(right.sessionId))
  const truncated = candidates.length > limit
  return {
    candidates: truncated ? candidates.slice(0, limit) : candidates,
    scanned: rows.length,
    skipped,
    truncated,
  }
}

/** 宿主对“会话仍有活动”的拒绝（WorkspaceActiveSessionError）：跳过而不是失败。 */
function isActiveRefusal(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  if (name === 'WorkspaceActiveSessionError') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /the session is active|session is active/i.test(message)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每小时批量归档的执行器。 */
export class AutoArchiver {
  private readonly deps: AutoArchiveDeps
  private scheduler: AutoArchiveScheduler | undefined
  private intervalHandle: unknown
  private initialHandle: unknown
  private running = false
  private disposed = false
  private readonly intervalMs: number
  private readonly initialDelayMs: number
  private readonly batchLimit: number
  private readonly log: (line: string) => void

  constructor(
    deps: AutoArchiveDeps,
    options: { intervalMs?: number; initialDelayMs?: number; batchLimit?: number; log?: (line: string) => void } = {},
  ) {
    this.deps = deps
    this.intervalMs = options.intervalMs ?? AUTO_ARCHIVE_INTERVAL_MS
    this.initialDelayMs = options.initialDelayMs ?? AUTO_ARCHIVE_INITIAL_DELAY_MS
    this.batchLimit = options.batchLimit ?? AUTO_ARCHIVE_BATCH_LIMIT
    this.log = options.log ?? deps.log ?? ((line) => console.log(line))
  }

  /** 注册定时器（幂等）。首轮延迟执行，之后按间隔执行。 */
  start(scheduler: AutoArchiveScheduler): void {
    if (this.disposed || this.intervalHandle !== undefined) return
    this.scheduler = scheduler
    this.intervalHandle = scheduler.setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.log('[dsh-session-bridge] auto-archive tick error: ' + messageOf(error))
      })
    }, this.intervalMs)
    if (typeof scheduler.setTimeout === 'function') {
      this.initialHandle = scheduler.setTimeout(() => {
        this.initialHandle = undefined
        void this.tick().catch((error: unknown) => {
          this.log('[dsh-session-bridge] auto-archive initial tick error: ' + messageOf(error))
        })
      }, this.initialDelayMs)
    }
  }

  /** 停止调度（插件卸载）。 */
  dispose(): void {
    this.disposed = true
    const scheduler = this.scheduler
    if (scheduler !== undefined) {
      if (this.intervalHandle !== undefined) {
        try { scheduler.clearInterval(this.intervalHandle) } catch { /* noop */ }
      }
      if (this.initialHandle !== undefined && typeof scheduler.clearTimeout === 'function') {
        try { scheduler.clearTimeout(this.initialHandle) } catch { /* noop */ }
      }
    }
    this.scheduler = undefined
    this.intervalHandle = undefined
    this.initialHandle = undefined
  }

  /** 执行一轮（测试可直接调用；running 防重入）。 */
  async tick(): Promise<AutoArchiveReport> {
    const at = (this.deps.now ?? Date.now)()
    const enabled = this.deps.policy.enabled()
    const days = this.deps.policy.days()
    if (!enabled) {
      return { at, enabled: false, busy: false, days, scanned: 0, archived: [], skipped: {}, failures: [], truncated: false }
    }
    if (this.running) {
      return { at, enabled: true, busy: true, days, scanned: 0, archived: [], skipped: {}, failures: [], truncated: false }
    }
    this.running = true
    try {
      let selection: AutoArchiveSelection
      try {
        selection = await selectAutoArchiveCandidates(this.deps, at, this.batchLimit)
      } catch (error: unknown) {
        return {
          at,
          enabled: true,
          busy: false,
          days,
          scanned: 0,
          archived: [],
          skipped: {},
          failures: [{ sessionId: '', message: 'candidate scan failed: ' + messageOf(error) }],
          truncated: false,
        }
      }
      const archived: string[] = []
      const failures: Array<{ sessionId: string; message: string }> = []
      const skipped: Partial<Record<AutoArchiveSkipReason, number>> = { ...selection.skipped }
      for (const candidate of selection.candidates) {
        try {
          await this.deps.workspaceRegistry.archiveSession(candidate.sessionId)
          archived.push(candidate.sessionId)
        } catch (error: unknown) {
          if (isActiveRefusal(error)) {
            increment(skipped, 'active')
            continue
          }
          failures.push({ sessionId: candidate.sessionId, message: messageOf(error) })
          increment(skipped, 'error')
        }
      }
      if (archived.length > 0 || failures.length > 0) {
        const summary = Object.entries(skipped)
          .filter(([, count]) => count !== undefined && count > 0)
          .map(([reason, count]) => reason + '=' + String(count))
          .join(' ')
        this.log(
          '[dsh-session-bridge] auto-archive: archived=' + String(archived.length)
            + (selection.truncated ? ' (batch limit reached)' : '')
            + (summary === '' ? '' : ' skipped ' + summary)
            + (failures.length === 0 ? '' : ' failed=' + String(failures.length)),
        )
      }
      return {
        at,
        enabled: true,
        busy: false,
        days,
        scanned: selection.scanned,
        archived,
        skipped,
        failures,
        truncated: selection.truncated,
      }
    } finally {
      this.running = false
    }
  }
}