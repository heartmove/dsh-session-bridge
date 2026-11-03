/**
 * 会话创建：`session_bridge_create` 工具与守护循环的「循环转移」共用同一条路径。
 *
 * 抽出这一层的理由：转移必须"先建好新会话、确认成功，再取消原会话"，否则创建失败
 * 就会丢任务；两处各写一份创建逻辑迟早漂移（模型继承、预设组合、workspace 记账、
 * 桥侧登记、followup 锚点，任何一处漏掉都会让新会话行为不同）。所以只保留一份实现，
 * tools 与 monitor 都调它。
 *
 * 这是**唯一**需要 `@deepseek-ai/dsh-agent` 运行时值（`installModelSelection`）的模块，
 * 单独成文件是为了让纯逻辑测试（core/loop-guard/handoff）不必加载宿主包。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as agentApi from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {
  attachSessionToWorkspace,
  maxSeq,
  resolveTargetCwd,
  sessionEvents,
  userMessage,
  workspaceByPath,
  type LiveAgentLike,
  type TargetCwdArgs,
} from './core.ts'
import type { BridgeRegistry } from './registry.ts'

interface ModelSelectionRef {
  current: { provider?: string; model?: string; reasoningEffort?: string } | undefined
  assembled?: undefined
}

/**
 * `@deepseek-ai/dsh-agent` 的 `installModelSelection` 有**两种历史签名**（0.2.2-alpha.3 改了）：
 *
 *  - DSH <= 0.2.1-rc.x：`installModelSelection(agentCtx, selection)` —— 第二参数是一个**可变引用**，
 *    它挂 `agent/request` 瀑布，每次请求都把 `selection.current` 写进请求配置；
 *  - DSH >= 0.2.2-alpha.3：`installModelSelection(agentCtx)` —— 选择权归 `AgentModel` +
 *    `modelSelection` session 投影（`agents.create({ agentOptions })` 是"尚未记录选择时"的路由兜底），
 *    函数只负责安装"模型切换提示"监听；第二参数被忽略。
 *
 * 两条路径都能拿到正确路由（我们**始终**把 provider/model/reasoningEffort 写进 `agentOptions`），
 * 差别只在"要不要额外装那个请求改写钩子"。所以这里按**形参个数**做特性探测：
 * 新宿主上多传的那个参数会被静默忽略，但显式分流能让意图留在代码里，也避免依赖"忽略多余实参"这种巧合。
 */
export type InstallModelSelection = (agentCtx: Context, selection?: ModelSelectionRef) => unknown

/**
 * 按宿主签名安装模型选择。返回 false 表示没有可用的安装器或安装失败，
 * 调用方据此退回自己的 `agent/request` 兜底钩子（旧宿主上的最后一道保险）。
 */
export function installModelSelectionCompat(
  install: InstallModelSelection | undefined,
  agentCtx: Context,
  selection: ModelSelectionRef,
): boolean {
  if (install === undefined) return false
  try {
    // 老签名：两参数，第二参数是可变选择引用。
    if (install.length >= 2) install(agentCtx, selection)
    // 新签名：一参数，选择已由 agentOptions/投影持有。
    else install(agentCtx)
    return true
  } catch (error) {
    console.warn(
      '[dsh-session-bridge] installModelSelection failed, falling back to the agent/request hook:',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}

/** 创建会话时的调用方：模型路由从它的 session 请求头继承，预设从它的 ctx 组合。 */
export interface BridgeSessionCaller {
  ctx: Context
  session: {
    header: { cwd?: string }
    requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
  }
}

/** 创建参数：workspaceId/cwd 目标解析 + 可选标题/首条提示/模型覆盖。 */
export interface CreateBridgeSessionOptions extends TargetCwdArgs {
  /** 调用方（工具调用时的当前 agent）；缺省则不做预设组合与模型继承。 */
  caller?: BridgeSessionCaller
  /** 调用方 cwd（优先于 caller.session.header.cwd，供工具显式传入）。 */
  callerCwd?: string
  title?: string
  prompt?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  /** 会话 id 前缀（默认 `sb-`）。 */
  idPrefix?: string
}

export interface CreatedBridgeSession {
  sessionId: string
  cwd: string
  workspaceId?: string
  agent: LiveAgentLike
  /** 发送 prompt 之前的日志锚点；未发送 prompt 时为 undefined。 */
  baselineSeq?: number
}

/**
 * 创建一个真实的顶层 DSH 会话（agent + session + workspace 记账 + 桥侧登记），
 * 可选立即投递首条提示。返回的 agent 已是 live agent。
 */
export async function createBridgeSession(
  ctx: Context,
  registry: BridgeRegistry,
  options: CreateBridgeSessionOptions,
): Promise<CreatedBridgeSession> {
  const caller = options.caller
  const targetCwd = await resolveTargetCwd(ctx, options.callerCwd ?? caller?.session.header.cwd, options)
  const callerHeader = caller?.session.requestHeader?.()
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : callerHeader?.config?.provider ?? ''
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : callerHeader?.config?.model ?? ''
  const reasoningEffort = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
    ? options.reasoningEffort
    : callerHeader?.config?.reasoningEffort

  const selection: ModelSelectionRef = {
    current: {
      ...(provider !== '' ? { provider } : {}),
      ...(model !== '' ? { model } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  }
  // 0.2.2-alpha.3 起 `installModelSelection` 从 `(agentCtx, selection)` 变成 `(agentCtx)`；
  // 按形参个数分流（见 installModelSelectionCompat），两种宿主都能用。
  const installModelSelection = (agentApi as unknown as { installModelSelection?: InstallModelSelection }).installModelSelection

  const sessionId = `${options.idPrefix ?? 'sb-'}${randomUUID()}`
  const agents = ctx.agents as unknown as {
    create(options: {
      sessionId: string
      meta?: { cwd?: string; agentPreset?: string }
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: Context) => void | Promise<void>
    }): Promise<{ agent: LiveAgentLike }>
  }
  const requestedPreset = typeof options.agentPreset === 'string' && options.agentPreset.trim() !== '' ? options.agentPreset.trim() : undefined
  const handle = await agents.create({
    sessionId,
    meta: {
      cwd: targetCwd,
      ...(requestedPreset === undefined ? {} : { agentPreset: requestedPreset }),
    },
    agentOptions: {
      ...(provider !== '' ? { provider } : {}),
      ...(model !== '' ? { model } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    setup: async (agentCtx: Context) => {
      if (requestedPreset !== undefined) {
        // 显式 agentPreset 就组合那一个预设。落到下面的 caller-join 会静默忽略请求：
        // id 仍然写进 session header，而 agent 实际跑在调用方的既有组合与工具上。
        const presets = ctx.agentPresets as unknown as { mount(agentCtx: Context, id: string): Promise<unknown> }
        await presets.mount(agentCtx, requestedPreset)
      } else if (caller !== undefined) {
        const presets = ctx.agentPresets as unknown as { composeFrom(agentCtx: Context, parentCtx: Context): string | undefined }
        presets.composeFrom(agentCtx, caller.ctx)
      }
      if (installModelSelectionCompat(installModelSelection, agentCtx, selection)) return
      // 兜底：只重写请求配置（模型选择拆分可接受）。
      const hookable = agentCtx as unknown as { on(name: string, listener: (...args: unknown[]) => unknown): unknown }
      hookable.on('agent/request', async (payload: unknown, next: unknown) => {
        const nxt = next as () => Promise<Record<string, unknown>>
        const resolved = await nxt()
        const sel = selection.current
        if (sel === undefined) return resolved
        const { reasoningEffort: _drop, ...rest } = resolved
        return {
          ...rest,
          ...(sel.provider === undefined ? {} : { provider: sel.provider }),
          ...(sel.model === undefined ? {} : { model: sel.model }),
          ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
        }
      })
    },
  })

  const agent = handle.agent
  // 镜像 session-controller.create 的记账：把新会话计入其 cwd 所属的
  // workspace，否则会话出现在 UI "未分组"（workspace sessionIds 只经
  // attach/bootstrap 两条路径记账）。
  const workspaceId = await attachSessionToWorkspace(ctx, sessionId as SessionId, targetCwd) ?? workspaceByPath(ctx, targetCwd)
  registry.record({
    sessionId,
    ...(typeof options.title === 'string' && options.title.trim() !== '' ? { title: options.title.trim() } : {}),
    cwd: targetCwd,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(provider !== '' ? { provider } : {}),
    ...(model !== '' ? { model } : {}),
    source: 'create',
  })

  // 发送 prompt 之前的日志锚点：交还调用方，供之后精确 wait 取回首条回复。
  // 新建会话的 maxSeq 为 -1（尚无事件），所以"未发送"用 undefined 哨兵而不是数值比较。
  let baselineSeq: number | undefined
  if (typeof options.prompt === 'string' && options.prompt.trim() !== '') {
    baselineSeq = maxSeq(sessionEvents(agent.session))
    agent.followup(userMessage(options.prompt.trim()))
    registry.touch(sessionId)
  }

  return {
    sessionId,
    cwd: targetCwd,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    agent,
    ...(baselineSeq === undefined ? {} : { baselineSeq }),
  }
}
