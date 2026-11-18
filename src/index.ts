/**
 * dsh-session-bridge host half: 注册会话桥工具
 * (create / send / resume / wait / read / find / status / cancel / monitor_* )，
 * 让当前 agent 能通过提示词创建主会话、向任意会话发消息、等待 / 读取回复、
 * 跨工作区查找会话，以及作为"监控 worker"对主任务会话做后台守护 —
 * 轮询进度、卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、完成即收尾。
 * 监控守护循环是插件自身的组件（见 monitor.ts），非独立插件。
 *
 * 另外挂载两件与"会话生命周期"有关的能力：
 *  - 收藏（favorites.ts）：工作区会话菜单里的收藏 / 取消收藏，会话行显示 ★，
 *    与置顶（pin）无关，不改变排序；
 *  - 自动归档（auto-archive.ts）：每小时把"长期未活动、未收藏、未指定保留"的主
 *    会话归档；默认关闭，设置页可配开关与天数。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BridgeRegistry } from './registry.ts'
import { SessionMonitor } from './monitor.ts'
import { registerBridgeTools, type BridgeEnv } from './tools.ts'
import { Config, createArchivePolicy, createLoopPolicy, readValue } from './config.ts'
import { createConfigWriter, registerLoopCommands } from './commands.ts'
import { FavoritesStore } from './favorites.ts'
import { AutoArchiver, type AutoArchiveRegistry, type AutoArchiveScheduler, type AutoArchiveSessionSource } from './auto-archive.ts'
import { registerBridgeRoutes, type SettingsRouteDeps } from './routes.ts'

/** 插件配置：循环自动中断 + 自动归档的开关与默认值（设置页表单与 /cot-loop 共用同一份）。 */
export { Config }

/** Plugin identity for cordis rows. */
export const name = 'dsh-session-bridge'

/** Services required before mounting. */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'tools', 'timer']

/**
 * 本部署是否接受写回配置：有 `configEditor` 才能持久化（没有时设置页只展示、
 * 保存按钮会明确报错，而不是假装成功）。
 */
function hasConfigEditor(ctx: Context): boolean {
  const bag = ctx as unknown as { get?: (name: string) => unknown; configEditor?: unknown }
  if (typeof bag.get === 'function') {
    try {
      return bag.get('configEditor') !== undefined
    } catch {
      return false
    }
  }
  return bag.configEditor !== undefined
}

/** Host plugin body. */
export function apply(ctx: Context, config?: unknown): void {
  const registry = new BridgeRegistry()
  void registry.load().catch((error: unknown) => {
    console.warn('[dsh-session-bridge] registry load failed:', error instanceof Error ? error.message : String(error))
  })
  // 循环策略：总开关与全局默认值都从 Config 的 volatile 引用实时读取，
  // 所以设置页/命令改开关后，运行中的守护下一个 tick 就按新值走（无需重启或重载）。
  const policy = createLoopPolicy(config)
  // 收藏集合：惰性加载（文件缺失/损坏都不阻塞插件），UI 与工具共用同一实例。
  const favorites = new FavoritesStore()
  void favorites.load().catch((error: unknown) => {
    console.warn('[dsh-session-bridge] favorites load failed:', error instanceof Error ? error.message : String(error))
  })
  // 自动归档：每轮实时读 autoArchive / autoArchiveDays / autoArchiveExclude。
  const archivePolicy = createArchivePolicy(config)
  const archiver = new AutoArchiver({
    policy: archivePolicy,
    favorites,
    persistence: ctx.sessionPersistence as unknown as AutoArchiveSessionSource,
    workspaceRegistry: ctx.workspaceRegistry as unknown as AutoArchiveRegistry,
    liveSessionIds: () => {
      const agents = ctx.agents as unknown as { list(): Array<{ id: string }> }
      return agents.list().map((agent) => agent.id)
    },
  })
  archiver.start(ctx as unknown as AutoArchiveScheduler)
  // 写回配置的能力（与 /cot-loop 共用同一条 configEditor 路径）。
  const writeConfig = createConfigWriter(ctx)
  // 设置页的数据面：读走 volatile 引用（实时生效值），写走 configEditor。
  const settingsBag = (config ?? {}) as Record<string, unknown>
  const settings: SettingsRouteDeps = {
    read: () => ({
      autoArchive: archivePolicy.enabled(),
      autoArchiveDays: archivePolicy.days(),
      autoArchiveExclude: readValue<string>(settingsBag.autoArchiveExclude) ?? '',
      loopGuard: policy.enabled(),
    }),
    write: writeConfig,
    writable: () => hasConfigEditor(ctx),
  }
  // 收藏与设置的同源 HTTP 面：浏览器半（会话菜单 / ★ / 设置页）用它读写；
  // 没有 webServer 时静默跳过。
  registerBridgeRoutes(ctx, { favorites, settings })
  // 监控循环会把任务转移到新会话，需要 registry 做桥侧登记（与工具共用同一条创建路径）。
  const monitor = new SessionMonitor(ctx, registry, undefined, policy)
  const env: BridgeEnv = { ctx, registry, monitor, policy, favorites, archive: archivePolicy }
  registerBridgeTools(env)
  // 斜杠命令 /cot-loop：与设置页共用同一份配置；commands 服务缺失时静默跳过。
  registerLoopCommands(ctx, { policy, writeConfig: createConfigWriter(ctx) })
  ctx.effect(() => () => {
    archiver.dispose()
    monitor.dispose()
  })
}