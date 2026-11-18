/**
 * 插件配置（volatile）—— 思维链循环自动中断的开关与全局默认值。
 *
 * 两种开启方式共用这一份配置：
 *  1. 命令 `/cot-loop on|off|status|...`：host 侧写回 profile patch，立即生效；
 *  2. 设置 → Plugins 页该插件的表单：dsh-settings 扫描 Config 里标了 volatile 的字段
 *     自动渲染控件，改完同样写回 profile patch。
 *
 * 字段标 volatile 后由 Loader 解析成**稳定引用**（读 `.get()`）：运行中的守护每次 tick
 * 都读同一个引用，所以开/关不需要重启或热重载插件。
 */
import z from '@deepseek-ai/schemastery'

/** 循环检测看哪一段内容。 */
export const LOOP_FIELD_VALUES = ['reasoning', 'text', 'both'] as const
/** 转移时对仍在运行的子代理的处置。 */
export const LOOP_DESCENDANTS_VALUES = ['report', 'stop', 'ignore'] as const

export type LoopFieldValue = (typeof LOOP_FIELD_VALUES)[number]
export type LoopDescendantsValue = (typeof LOOP_DESCENDANTS_VALUES)[number]

/**
 * 标记一个字段为 volatile（Loader 把它解析成稳定引用，设置页把它渲染成可热改的控件）。
 *
 * 运行时 schemastery 有 `.volatile()`，但随包发布的类型定义里没有它，所以这里做一次
 * 结构探测；旧版本上没有该方法时退化成普通字段（设置页不显示该项，功能不受影响）。
 */
function volatile<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/**
 * 配置形状。**必须显式命名，不能靠推导**：`Config` 是导出的（设置页读它、`pnpm smoke`
 * 也断言它），而 `tsc --emitDeclarationOnly` 要为它生成 `.d.ts`——推导出来的类型会引用
 * pnpm 虚拟 store 里的深路径 `.pnpm/@deepseek-ai+schemastery@x.y.z/node_modules/...`，
 * 在**干净安装**（CI/Linux）上直接失败：
 *
 *   src/config.ts(34,14): error TS2742: The inferred type of 'Config' cannot be named
 *   without a reference to '.pnpm/@deepseek-ai+schemastery@3.18.5/...'. This is likely
 *   not portable. A type annotation is necessary.
 *
 * 注意这个错**只在干净安装上出现**：本机 `build.sh` 会在 `node_modules/` 里建 junction
 * 指向本地 dsh checkout，类型解析到稳定路径，于是本地 `pnpm build` 侥幸通过（见 AGENTS.md §2）。
 * 显式标注后 `.d.ts` 里只剩包名 `@deepseek-ai/schemastery`，与官方插件的
 * `export declare const Config: Schema<X>` 写法一致。
 */
export interface PluginConfig {
  loopGuard: boolean
  loopField: string
  loopMinCycles: number
  loopMinRepeats: number
  loopMinConfidence: number
  loopMinHits: number
  loopCooldownMs: number
  loopMaxTransfers: number
  loopDescendants: string
  autoArchive: boolean
  autoArchiveDays: number
  autoArchiveExclude: string
}

/** Cordis config schema：由 profile 的 entry 配置或设置页表单填充。 */
export const Config: z<PluginConfig> = z.object({
  loopGuard: volatile(
    z
      .boolean()
      .default(true)
      .description('思维链循环自动中断总开关：关掉后任何监控都不再做循环检测。'),
  ),
  loopField: volatile(
    z
      .string()
      .default('reasoning')
      .description('循环检测看哪一段：reasoning（思考阶段，默认）/ text（最终回复）/ both。'),
  ),
  loopMinCycles: volatile(
    z
      .number()
      .step(1)
      .min(1)
      .default(2)
      .description('最小周期数：同一个单元要重复多少轮才算循环。'),
  ),
  loopMinRepeats: volatile(
    z
      .number()
      .step(1)
      .min(2)
      .default(3)
      .description('最小重复次数（有效下限取它与 loopMinCycles 的较大者）。'),
  ),
  loopMinConfidence: volatile(
    z
      .number()
      .min(0)
      .max(1)
      .default(0.6)
      .description('最小置信度：判定循环所需的把握程度。'),
  ),
  loopMinHits: volatile(
    z
      .number()
      .step(1)
      .min(1)
      .default(1)
      .description('连续命中几次才动手（1 = 首次命中即中断并转移）。'),
  ),
  loopCooldownMs: volatile(
    z
      .number()
      .step(1)
      .min(0)
      .default(60_000)
      .description('两次循环处置之间的冷却时间（毫秒）。'),
  ),
  loopMaxTransfers: volatile(
    z
      .number()
      .step(1)
      .min(0)
      .default(3)
      .description('同一个任务最多转移几次（0 = 只中断不转移）。'),
  ),
  loopDescendants: volatile(
    z
      .string()
      .default('report')
      .description('转移时如何处理仍在运行的子代理：report（只写进交接说明）/ stop（先停掉）/ ignore（不提）。'),
  ),
  autoArchive: volatile(
    z
      .boolean()
      .default(false)
      .description('会话自动归档总开关：默认关闭；开启后每小时批量归档长期未活动的会话。'),
  ),
  autoArchiveDays: volatile(
    z
      .number()
      .step(1)
      .min(1)
      .max(3650)
      .default(7)
      .description('自动归档阈值：最后活动早于这么多天的会话才会被归档（默认 7）。'),
  ),
  autoArchiveExclude: volatile(
    z
      .string()
      .default('')
      .description('永不自动归档的会话 id 保留名单，逗号或空白分隔；与收藏一起构成“指定保留”的会话。'),
  ),
})

/** volatile 引用（Loader 的解析产物）：值由 owning runtime 原地更新。 */
interface VolatileRef<T> {
  get(): T
}

function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as VolatileRef<unknown>).get === 'function'
}

/** 读一个配置值：兼容 Loader 的 volatile 引用与测试里直接传进来的裸值。 */
export function readValue<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined
  if (isVolatileRef(value)) return value.get() as T
  return value as T
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = readValue<string>(value)
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function readNumber(value: unknown, fallback: number, min: number, max: number, integer = true): number {
  const raw = readValue<number>(value)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const clamped = Math.min(max, Math.max(min, raw))
  return integer ? Math.round(clamped) : clamped
}

/** 循环检测的全局默认值：守护没显式传参时用这一份。 */
export interface LoopPolicyDefaults {
  field: LoopFieldValue
  minCycles: number
  minRepeats: number
  minConfidence: number
  minHits: number
  cooldownMs: number
  maxTransfers: number
  descendants: LoopDescendantsValue
}

/** 插件级循环策略：总开关 + 全局默认值，两者都**实时**读取（volatile 引用）。 */
export interface LoopPolicy {
  /** 总开关：false 时守护完全跳过循环检测（已存在的守护也立即停手）。 */
  enabled(): boolean
  /** 内存覆盖值（命令在写不回配置时的退化路径）；undefined = 跟随配置。 */
  override(): boolean | undefined
  setOverride(next: boolean | undefined): void
  /** 全局默认值（实时读取，供 monitor_start 未显式传参时使用）。 */
  defaults(): LoopPolicyDefaults
  /** 配置里是否声明了 loopGuard（供命令提示"配置未加载"）。 */
  hasConfig(): boolean
}

/** 从插件的 Config 构造循环策略；config 缺失时全部走内置默认值。 */
export function createLoopPolicy(config?: unknown): LoopPolicy {
  const bag = (config ?? {}) as Record<string, unknown>
  let override: boolean | undefined
  return {
    enabled() {
      if (override !== undefined) return override
      const raw = readValue<boolean>(bag.loopGuard)
      return raw === undefined ? true : raw !== false
    },
    override: () => override,
    setOverride(next) {
      override = next
    },
    defaults() {
      return {
        field: readEnum(bag.loopField, LOOP_FIELD_VALUES, 'reasoning'),
        minCycles: readNumber(bag.loopMinCycles, 2, 1, 64),
        minRepeats: readNumber(bag.loopMinRepeats, 3, 2, 64),
        minConfidence: readNumber(bag.loopMinConfidence, 0.6, 0, 1, false),
        minHits: readNumber(bag.loopMinHits, 1, 1, 64),
        cooldownMs: readNumber(bag.loopCooldownMs, 60_000, 0, 86_400_000),
        maxTransfers: readNumber(bag.loopMaxTransfers, 3, 0, 64),
        descendants: readEnum(bag.loopDescendants, LOOP_DESCENDANTS_VALUES, 'report'),
      }
    },
    hasConfig() {
      return readValue<boolean>(bag.loopGuard) !== undefined
    },
  }
}

/**
 * 自动归档策略：总开关、天数与“指定保留”名单。
 *
 * 三者都从 volatile 引用**实时**读取（设置页改完下一轮就生效，无需重启），
 * 所以自动归档引擎每轮都问一次 policy，而不是构造时缓存一份快照。
 */
export interface ArchivePolicy {
  /** 总开关（默认 false = 不归档）。 */
  enabled(): boolean
  /** 归档阈值天数（默认 7，钳制在 1..3650）。 */
  days(): number
  /** “指定的会话”保留名单（逗号 / 空白分隔的 session id）。 */
  exclude(): ReadonlySet<string>
}

/** 把逗号 / 空白分隔的名单解析成去重的 id 集合。 */
export function parseSessionIdList(raw: unknown): Set<string> {
  const text = readValue<string>(raw)
  const ids = new Set<string>()
  if (typeof text !== 'string') return ids
  for (const part of text.split(/[\s,;]+/)) {
    const id = part.trim()
    if (id !== '') ids.add(id)
  }
  return ids
}

/** 从插件的 Config 构造归档策略；config 缺失时全部走内置默认值。 */
export function createArchivePolicy(config?: unknown): ArchivePolicy {
  const bag = (config ?? {}) as Record<string, unknown>
  return {
    enabled() {
      return readValue<boolean>(bag.autoArchive) === true
    },
    days() {
      return readNumber(bag.autoArchiveDays, 7, 1, 3650)
    },
    exclude() {
      return parseSessionIdList(bag.autoArchiveExclude)
    },
  }
}
