/**
 * dsh-session-bridge host half: 注册会话桥工具
 * (create / send / resume / wait / read / find / status / cancel / monitor_* )，
 * 让当前 agent 能通过提示词创建主会话、向任意会话发消息、等待 / 读取回复、
 * 跨工作区查找会话，以及作为"监控 worker"对主任务会话做后台守护 —
 * 轮询进度、卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、完成即收尾。
 * 监控守护循环是插件自身的组件（见 monitor.ts），非独立插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BridgeRegistry } from './registry.ts'
import { SessionMonitor } from './monitor.ts'
import { registerBridgeTools, type BridgeEnv } from './tools.ts'

/** Plugin identity for cordis rows. */
export const name = 'dsh-session-bridge'

/** Services required before mounting. */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'tools', 'timer']

/** Host plugin body. */
export function apply(ctx: Context): void {
  const registry = new BridgeRegistry()
  void registry.load().catch((error: unknown) => {
    console.warn('[dsh-session-bridge] registry load failed:', error instanceof Error ? error.message : String(error))
  })
  const monitor = new SessionMonitor(ctx)
  const env: BridgeEnv = { ctx, registry, monitor }
  registerBridgeTools(env)
  ctx.effect(() => () => monitor.dispose())
}
