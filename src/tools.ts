/**
 * dsh-session-bridge 模型面向工具：create / send / resume / wait / read / find。
 * 全部经插件宿主 ctx 操作真实 DSH 会话（顶层主会话与任意其它会话）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  BridgeFindItem,
  BridgeMessageRow,
  BridgeStatusSnapshot,
  BridgeWaitResult,
  LiveAgentLike,
} from './core.ts'
import {
  archivedEntries,
  attachSessionToWorkspace,
  foldMessages,
  inspectPersistedSession,
  isStalled,
  maxSeq,
  resolveTargetCwd,
  segmentsSince,
  sessionEvents,
  statusSnapshot,
  titleOf,
  userMessage,
  waitForReply,
  workspaceByPath,
  workspaceBySession,
} from './core.ts'
import { createBridgeSession, type BridgeSessionCaller } from './session-create.ts'
import type { BridgeRegistry } from './registry.ts'
import type { SessionMonitor, MonitorConfig, MonitorEntryState, CoTRule } from './monitor.ts'
import type { ArchivePolicy, LoopPolicy } from './config.ts'
import type { FavoritesStore } from './favorites.ts'

type SessionIdBrand = { readonly __sessionIdBrand?: never }

export interface BridgeEnv {
  ctx: Context
  registry: BridgeRegistry
  monitor: SessionMonitor
  /** 插件级循环策略（总开关 + 全局默认值）：渲染与默认值都读它。 */
  policy: LoopPolicy
  /** 收藏集合：会话菜单/行 ★ 与 session_bridge_favorite 共用的唯一真源。 */
  favorites: FavoritesStore
  /** 自动归档策略：收藏功能跟着它走（关闭时收藏 UI 与本工具一起下线）。 */
  archive: ArchivePolicy
}

function asJson(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

const MAX_WAIT_MS = 3_600_000

function clampTimeout(ms: number | undefined, fallback = 180_000): number {
  if (ms === undefined) return fallback
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(ms)}`)
  return Math.min(ms, MAX_WAIT_MS)
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(limit)}`)
  return Math.min(limit, max)
}

/** 结构取活 agent（ctx.agents 的返回类型按 dsh-agent 的 Agent 形状；这里用结构面）。 */
function liveAgent(env: BridgeEnv, sessionId: string): LiveAgentLike | undefined {
  const agents = env.ctx.agents as unknown as { get(id: string): LiveAgentLike | undefined }
  return agents.get(sessionId)
}

function liveAgents(env: BridgeEnv): LiveAgentLike[] {
  const agents = env.ctx.agents as unknown as { list(): LiveAgentLike[] }
  return agents.list()
}

/** 等待结果里的状态附注行（wait / send / create 三处渲染共用）。 */
function waitNotes(reply: Record<string, unknown>): string[] {
  const notes: string[] = []
  if (reply.timedOut === true) notes.push('[wait timed out]')
  if (reply.stale === true) notes.push('[stale] pre-existing reply — nothing new arrived during the wait')
  if (reply.aborted === true) notes.push('[wait aborted]')
  return notes
}

/** 渲染等待结果为 JSON 友好值。 */
function renderWait(wait: BridgeWaitResult): Record<string, unknown> {
  const row = wait.message
  return {
    message: row === null ? null : {
      seq: row.seq,
      role: row.role,
      ...(row.text !== undefined ? { text: row.text } : {}),
      ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
      images: row.images,
      toolCalls: row.toolCalls ?? [],
    },
    seq: wait.seq,
    turnEnded: wait.turnEnded,
    timedOut: wait.timedOut,
    ...(wait.stale === true ? { stale: true } : {}),
    aborted: wait.aborted,
    waitedMs: wait.waitedMs,
  }
}

/** 等待参数（send/create 共用）。 */
interface WaitArgs {
  waitForReply?: boolean
  timeoutMs?: number
}

async function maybeWait(env: BridgeEnv, session: Session, baselineSeq: number, args: WaitArgs, signal: AbortSignal): Promise<ReturnType<typeof renderWait> | undefined> {
  if (args.waitForReply !== true) return undefined
  const result = await waitForReply({
    session,
    baselineSeq,
    timeoutMs: clampTimeout(args.timeoutMs),
    signal,
    requireTurnEnd: false,
  })
  return renderWait(result)
}

interface CreateArgs {
  workspaceId?: string
  cwd?: string
  title?: string
  prompt?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  waitForReply?: boolean
  timeoutMs?: number
}

function registerCreate(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_create',
    description: 'Create a NEW main session (a top-level session that also appears in the DSH session list) and optionally send its first prompt. '
      + 'The session runs in the target workspace: pass workspaceId or cwd to target another workspace (cross-workspace), otherwise the caller\'s current workspace is used. '
      + 'Provider/model default to the current conversation; titles are only a bridge-side label (the real session title is generated automatically). '
      + 'Returns the new session id; with waitForReply=true it blocks until the first assistant reply completes and returns it.',
    parameters: {
      workspaceId: { type: 'string', description: 'Target workspace id (from session_bridge_find). Takes precedence over cwd.' },
      cwd: { type: 'string', description: 'Target working directory for the new session (absolute path or any spelling).' },
      title: { type: 'string', description: 'Optional bridge-side label remembered for find-by-name; does not rename the real session.' },
      prompt: { type: 'string', description: 'Optional first prompt sent right after creation.' },
      agentPreset: { type: 'string', description: 'Optional agent preset id for composition.' },
      provider: { type: 'string', description: 'LLM provider override (default: inherit from the current conversation).' },
      model: { type: 'string', description: 'LLM model override (default: inherit from the current conversation).' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort override for the new session.' },
      waitForReply: { type: 'boolean', description: 'When true and prompt is given, wait for the first assistant reply (default false).' },
      timeoutMs: { type: 'number', description: 'Wait timeout in milliseconds (default 180000, max 3600000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const lines: string[] = [`created main session ${String(v.sessionId)}`]
        if (typeof v.cwd === 'string') lines.push(`cwd: ${v.cwd}`)
        if (typeof v.title === 'string') lines.push(`title: ${v.title}`)
        const reply = v.reply as Record<string, unknown> | undefined
        if (typeof v.sinceSeq === 'number') lines.push(`sinceSeq: ${String(v.sinceSeq)} (pass to session_bridge_wait)`)
        if (reply !== undefined) {
          lines.push(`reply: ${String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)')}`)
          lines.push(...waitNotes(reply))
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: CreateArgs, exec) {
      const caller = exec.agent as LiveAgentLike | undefined
      // 创建逻辑与守护循环的「循环转移」共用一条路径（session-create.ts）：
      // 模型继承、预设组合、workspace 记账、桥侧登记只保留一份实现，避免两处漂移。
      const created = await createBridgeSession(env.ctx, env.registry, {
        ...(caller === undefined ? {} : { caller: { ctx: caller.ctx, session: caller.session as unknown as BridgeSessionCaller['session'] } }),
        callerCwd: caller?.session.header.cwd,
        ...(typeof args.workspaceId === 'string' ? { workspaceId: args.workspaceId } : {}),
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
        ...(typeof args.agentPreset === 'string' ? { agentPreset: args.agentPreset } : {}),
        ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.reasoningEffort === 'string' ? { reasoningEffort: args.reasoningEffort } : {}),
      })

      let reply: ReturnType<typeof renderWait> | undefined
      // 只有真的发了 prompt 才有锚点（baselineSeq）可等；未发 prompt 时 waitForReply 无意义。
      if (args.waitForReply === true && created.baselineSeq !== undefined) {
        reply = await maybeWait(env, created.agent.session, created.baselineSeq, args, exec.signal)
      }

      return asJson({
        sessionId: created.sessionId,
        cwd: created.cwd,
        ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }),
        ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title.trim() } : {}),
        ...(reply === undefined && created.baselineSeq !== undefined ? { sinceSeq: created.baselineSeq } : {}),
        ...(reply === undefined ? {} : { reply }),
      })
    },
  }))
}

interface SendArgs {
  sessionId: string
  message: string
  mode?: 'queue' | 'steer'
  waitForReply?: boolean
  timeoutMs?: number
}

function registerSend(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_send',
    description: 'Send a message to any session (by id) and let it start working. If the session is not currently live (offline/persisted), call session_bridge_resume first. mode=queue appends a normal turn; mode=steer injects a step that interrupts the running turn. With waitForReply=true the tool blocks until that session produces its next assistant reply (turn complete), useful for reply-driven orchestration across sessions.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id (from session_bridge_find / session_bridge_create).' },
      message: { type: 'string', required: true, description: 'Message text to send as a user turn.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) appends a turn; steer interrupts the running turn.' },
      waitForReply: { type: 'boolean', description: 'When true, wait for the next assistant reply after sending (default false).' },
      timeoutMs: { type: 'number', description: 'Wait timeout in milliseconds (default 180000, max 3600000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const reply = v.reply as Record<string, unknown> | null | undefined
        const lines = ['sent to ' + String(v.sessionId)]
        if (typeof v.sinceSeq === 'number') lines.push('sinceSeq: ' + String(v.sinceSeq) + ' (pass to session_bridge_wait)')
        if (reply !== null && reply !== undefined) {
          lines.push('reply: ' + String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)'))
          lines.push(...waitNotes(reply))
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: SendArgs, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      if (typeof args.message !== 'string' || args.message.trim() === '') throw new Error('invalid message: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_bridge_resume first to bring it online (or session_bridge_find to locate it)')
      }
      const baseline = maxSeq(sessionEvents(agent.session))
      if (args.mode === 'steer') agent.steer(userMessage(args.message.trim()))
      else agent.followup(userMessage(args.message.trim()))
      const headerCwd = agent.session.header.cwd
      // 幂等补齐记账：bridge 早期直接 agents.create 未 attach，这里兜底
      // 让存量会话也能归位到其 cwd 所属的 workspace（而非 UI "未分组"）。
      const sendWorkspaceId = await attachSessionToWorkspace(env.ctx, args.sessionId as SessionId, headerCwd) ?? workspaceByPath(env.ctx, headerCwd)
      env.registry.touch(args.sessionId, {
        ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
        ...(sendWorkspaceId === undefined ? {} : { workspaceId: sendWorkspaceId }),
      })
      const reply = await maybeWait(env, agent.session, baseline, args, exec.signal)
      // 未同步等待时把发送前的锚点交还给调用方：之后无论隔多久，用该 sinceSeq 调
      // session_bridge_wait 都能稳定取回"本次发送之后的回复"（不受调用方延迟影响）。
      return asJson({ accepted: true, sessionId: args.sessionId, ...(reply === undefined ? { sinceSeq: baseline } : { reply }) })
    },
  }))
}

interface ResumeArgs {
  sessionId: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

function registerResume(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_resume',
    description: 'Bring an existing persisted (offline) session back online so session_bridge_send / session_bridge_wait / session_bridge_read can operate on it. Resumes by session id; the session becomes live again (same as opening it). If already live this is a no-op. Provider/model default to the session previous config.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to resume (persisted log must exist).' },
      provider: { type: 'string', description: 'Optional provider override.' },
      model: { type: 'string', description: 'Optional model override.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort override.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: (v.alreadyLive === true
          ? 'session ' + String(v.sessionId) + ' is already live'
          : 'resumed session ' + String(v.sessionId) + (typeof v.cwd === 'string' ? ' (cwd: ' + v.cwd + ')' : '')) }]
      },
    },
    async execute(args: ResumeArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const existing = liveAgent(env, args.sessionId)
      if (existing !== undefined) {
        env.registry.touch(args.sessionId)
        return asJson({
          sessionId: args.sessionId,
          alreadyLive: true,
          ...(existing.session.header.cwd === undefined ? {} : { cwd: existing.session.header.cwd }),
          title: titleOf(sessionEvents(existing.session)) ?? null,
          running: existing.status === 'running',
        })
      }
      let headers: readonly { id: string; cwd?: string; createdAt: number }[] = []
      try {
        // dsh >= 0.1.5-alpha.1：list() 返回 { header, ... } 快照；映射回平铺字段。
        const persistence = env.ctx.sessionPersistence as unknown as { list(): Promise<readonly { header: { id: string; cwd?: string; createdAt: number } }[]> }
        headers = (await persistence.list()).map((rec) => ({
          id: rec.header.id,
          ...(rec.header.cwd === undefined ? {} : { cwd: rec.header.cwd }),
          createdAt: rec.header.createdAt,
        }))
      } catch (error) {
        throw new Error('session persistence unavailable: ' + (error instanceof Error ? error.message : String(error)))
      }
      const header = headers.find((h) => h.id === args.sessionId)
      if (header === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is unknown (no live agent and no persisted log) — use session_bridge_find to locate existing sessions')
      }
      const agents = env.ctx.agents as unknown as {
        resume(options: { resumeSessionId: string; agentOptions?: Record<string, unknown> }): Promise<{ agent: LiveAgentLike }>
      }
      const agentOptions: Record<string, unknown> = {}
      if (typeof args.provider === 'string' && args.provider !== '') agentOptions.provider = args.provider
      if (typeof args.model === 'string' && args.model !== '') agentOptions.model = args.model
      if (typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '') agentOptions.reasoningEffort = args.reasoningEffort
      const handle = await agents.resume({ resumeSessionId: args.sessionId, ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}) })
      const headerCwd = header.cwd
      const resumeWorkspaceId = await attachSessionToWorkspace(env.ctx, args.sessionId as SessionId, headerCwd) ?? workspaceByPath(env.ctx, headerCwd)
      env.registry.record({
        sessionId: args.sessionId,
        ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
        ...(resumeWorkspaceId === undefined ? {} : { workspaceId: resumeWorkspaceId }),
        source: 'resume',
      })
      return asJson({
        sessionId: args.sessionId,
        resumed: true,
        ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
        title: titleOf(sessionEvents(handle.agent.session)) ?? null,
      })
    },
  }))
}

interface WaitArgsTool {
  sessionId: string
  sinceSeq?: number
  timeoutMs?: number
  requireTurnEnd?: boolean
  waitFor?: 'reply' | 'segment'
}

function registerWait(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_wait',
    description: 'Wait for a session next assistant output: blocks (polling the session log) until a NEW assistant output appears after sinceSeq (default: the latest seq at call time). waitFor=reply returns as soon as a new assistant TEXT reply is readable; waitFor=segment returns as soon as any new COMPLETED output segment appears (an assistant/message step — text, reasoning, or tool-call turn), i.e. it does NOT wait for the whole turn, so you can observe the chain-of-thought/output paragraph by paragraph as it is produced. If no new output arrives within the budget, the latest PRE-EXISTING reply/segment is returned with stale=true (so an already-landed reply is never lost as "(no text)"). Returns the output summary, or timedOut/aborted when the deadline or caller cancellation ends the wait. Use it to consume output produced asynchronously by another session (e.g. a session you sent a message to, or one working on its own); to read a reply that may already exist, pass the sinceSeq anchor returned by send/create.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to wait on.' },
      sinceSeq: { type: 'number', description: 'Only replies after this event seq count (default: latest seq at call time; -1 = count every event, the anchor returned by create for a brand-new session).' },
      timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (default 180000, max 3600000); timed out waits return the partial result instead of failing.' },
      requireTurnEnd: { type: 'boolean', description: 'When true, wait for the reply turn/end to settle before returning (default false; false returns as soon as the reply text is readable).' },
      waitFor: { type: 'string', enum: ['reply', 'segment'], description: 'reply (default) waits for a new assistant TEXT reply; segment waits for any new completed output segment (an assistant/message step, incl. reasoning/tool turns) and returns it immediately, without waiting for the whole turn.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const reply = v.reply as Record<string, unknown> | null | undefined
        if (reply === null || reply === undefined) return [{ type: 'text' as const, text: 'no reply observed' }]
        const message = (reply.message as Record<string, unknown> | null)
        const lines = [message === null
          ? 'no new reply within ' + String(reply.waitedMs ?? '?') + 'ms (no assistant text in this session)'
          : 'reply seq ' + String(reply.seq) + ': ' + String(message.text ?? '(no text)')]
        if (typeof reply.turnEnded === 'boolean') lines.push('turnEnded: ' + String(reply.turnEnded))
        lines.push(...waitNotes(reply))
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: WaitArgsTool, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_bridge_resume first (waiting requires a live session)')
      }
      // 默认 baseline = 调用时刻的日志最大 seq（即工具描述承诺的 "latest seq at call
      // time"，两种 waitFor 模式统一）：只等待之后新出现的输出。既有回复不会被误当成
      // 新输出，但也绝不会被吞掉 —— waitForReply 在零新输出时会回落它并置 stale:true。
      // 调用方若要在"回复早已落地"之后再精确取回它，应传 send/create 返回的 sinceSeq 锚点。
      const baseline = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= -1
        ? args.sinceSeq
        : maxSeq(sessionEvents(agent.session))
      const result = await waitForReply({
        session: agent.session,
        baselineSeq: baseline,
        timeoutMs: clampTimeout(args.timeoutMs),
        signal: exec.signal,
        requireTurnEnd: args.requireTurnEnd === true,
        ...(args.waitFor === 'segment' ? { waitForSegment: true } : {}),
      })
      env.registry.touch(args.sessionId)
      return asJson({
        sessionId: args.sessionId,
        sinceSeq: baseline,
        reply: renderWait(result),
        running: agent.status === 'running',
      })
    },
  }))
}

interface SegmentsArgs {
  sessionId: string
  sinceSeq?: number
  limit?: number
}
function registerSegments(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_segments',
    description: 'Read the completed output segments of a session incrementally - each finished assistant step (one assistant/message paragraph), without waiting for the whole turn. Pass sinceSeq to page forward. Use this to watch a session produce its chain-of-thought / output paragraph by paragraph as each step finishes.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to read segments from (live or offline).' },
      sinceSeq: { type: 'number', description: 'Only return completed segments after this event seq (paging cursor).' },
      limit: { type: 'number', description: 'Maximum number of segments to return (default 10, max 50).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const segs = (v.segments as Array<Record<string, unknown>> | null) ?? []
        if (segs.length === 0) return [{ type: 'text' as const, text: '(no completed segments)' }]
        const lines = segs.map((sg) => {
          const head = 'seg #' + String(sg.seq) + ' (turn ' + String(sg.turn) + ' step ' + String(sg.step) + ')'
          const text = typeof sg.text === 'string' ? sg.text : ''
          const reason = typeof sg.reasoning === 'string' && sg.reasoning !== '' ? ' [reasoning ' + sg.reasoning.length + ' chars]' : ''
          const tools = Array.isArray(sg.toolCalls) && sg.toolCalls.length > 0 ? ' [tools: ' + sg.toolCalls.join(',') + ']' : ''
          return head + tools + reason + ': ' + text.slice(0, 160)
        })
        // 分批读取时必须把"还有多少段"告诉模型：否则它会把本批当成会话的全部输出，
        // 不再用 nextCursorSeq 继续翻页（render 才是模型看到的内容，schema 字段看不到）。
        const remaining = typeof v.remaining === 'number' ? v.remaining : 0
        if (remaining > 0) lines.push('(more: ' + String(remaining) + ' newer segments remain — pass sinceSeq: ' + String(v.nextCursorSeq) + ' to page forward)')
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: SegmentsArgs) {
      const agent = liveAgent(env, args.sessionId)
      let events: readonly SessionEvent[]
      let live: boolean
      if (agent !== undefined) {
        events = sessionEvents(agent.session)
        live = true
      } else {
        try {
          const inspection = await inspectPersistedSession(env.ctx, args.sessionId)
          events = inspection.events
          live = false
        } catch (error) {
          throw new Error(String(error))
        }
      }
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : 0
      const limit = clampLimit(args.limit, 10, 50)
      // sinceSeq 是"向前翻页"的排他游标，所以本批取 sinceSeq 之后**最早的** limit 段
      // （不是最新的 limit 段），nextCursorSeq 只落在本批最后一段。这两件事缺一不可：
      // 不截断会把整个会话的段落一次塞进上下文（长会话一次几万 token），而且
      // nextCursorSeq 会跳到会话末尾，让 sinceSeq 分页永远翻不动。
      const all = segmentsSince(events, sinceSeq)
      const segs = all.slice(0, limit)
      env.registry.touch(args.sessionId)
      const nextCursorSeq = segs.length === 0 ? sinceSeq : (segs[segs.length - 1]?.seq ?? sinceSeq)
      return asJson({
        sessionId: args.sessionId,
        live,
        nextCursorSeq,
        returned: segs.length,
        remaining: all.length - segs.length,
        segments: segs.map((sg) => ({
          seq: sg.seq,
          time: sg.time,
          turn: sg.turn,
          step: sg.step,
          openTurn: sg.openTurn,
          ...(sg.text === undefined ? {} : { text: sg.text }),
          ...(sg.reasoning === undefined ? {} : { reasoning: sg.reasoning }),
          ...(sg.toolCalls.length > 0 ? { toolCalls: sg.toolCalls } : {}),
        })),
      })
    },
  }))
}

interface ReadArgs {
  sessionId: string
  sinceSeq?: number
  limit?: number
  role?: 'user' | 'assistant' | 'both'
  includeReasoning?: boolean
}

function registerRead(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_read',
    description: 'Read messages from any session — live or persisted (offline) — folding its event log into user/assistant text rows. By default returns the latest 20 messages; use limit for more (max 100) and sinceSeq to page forward from an event seq. role filters user/assistant rows; includeReasoning=false drops reasoning blocks.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to read (any session, even offline).' },
      sinceSeq: { type: 'number', description: 'Only return messages with seq greater than this value (paging).' },
      limit: { type: 'number', description: 'Number of most recent messages to return (default 20, max 100).' },
      role: { type: 'string', enum: ['user', 'assistant', 'both'], description: 'role filter (default both).' },
      includeReasoning: { type: 'boolean', description: 'Include assistant reasoning blocks (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const messages = (v.messages as Array<Record<string, unknown>> | null) ?? []
        if (messages.length === 0) return [{ type: 'text' as const, text: '(no messages)' }]
        const lines = messages.map((m) => {
          const head = m.role === 'user' ? 'user' : 'assistant'
          const text = typeof m.text === 'string' ? m.text : '(no text)'
          return head + ' #' + String(m.seq) + ': ' + text
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: ReadArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      let events: readonly SessionEvent[]
      let live: boolean
      let cwd: string | undefined
      if (agent !== undefined) {
        events = sessionEvents(agent.session)
        live = true
        cwd = agent.session.header.cwd
      } else {
        let inspection: { events: readonly SessionEvent[]; meta: { cwd?: string } }
        try {
          inspection = await inspectPersistedSession(env.ctx, args.sessionId)
        } catch (error) {
          throw new Error('cannot read session ' + JSON.stringify(args.sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
        }
        events = inspection.events
        live = false
        cwd = inspection.meta.cwd
      }
      let rows = foldMessages(events)
      if (args.role === 'user') rows = rows.filter((r) => r.role === 'user')
      if (args.role === 'assistant') rows = rows.filter((r) => r.role === 'assistant')
      if (args.includeReasoning === false) rows = rows.map((r) => ({ ...r, reasoning: undefined }))
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : undefined
      if (sinceSeq !== undefined) rows = rows.filter((r) => r.seq > sinceSeq)
      const limit = clampLimit(args.limit, 20, 100)
      rows = rows.slice(-limit)
      const workspaceId = workspaceByPath(env.ctx, cwd)
      env.registry.touch(args.sessionId, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
      return asJson({
        sessionId: args.sessionId,
        live,
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        title: titleOf(events) ?? null,
        messages: rows.map((r) => ({
          seq: r.seq,
          time: r.time,
          role: r.role,
          ...(r.text === undefined ? {} : { text: r.text }),
          ...(r.reasoning === undefined ? {} : { reasoning: r.reasoning }),
          images: r.images,
          ...(r.toolCalls === undefined ? {} : { toolCalls: r.toolCalls }),
        })),
        nextSeq: maxSeq(events),
        totalEvents: events.length,
      })
    },
  }))
}

interface FindArgs {
  query?: string
  sessionId?: string
  title?: string
  workspaceId?: string
  cwd?: string
  liveOnly?: boolean
  limit?: number
}

function registerFind(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_find',
    description: 'Find sessions by name (title), session id, workspace, or directory — across ALL workspaces. Live agents are always current; persisted (offline) sessions come from the durable session store. A plain query matches session id / title / cwd as a case-insensitive substring. Offline titles are resolved lazily from the session log (bounded); bridge-registered titles (from session_bridge_create title) are matched as aliases and used as a fallback. Returns metadata + live/running state, ready to pass to create/send/resume/wait/read.',
    parameters: {
      query: { type: 'string', description: 'Substring matched against session id, title, and cwd (case-insensitive).' },
      sessionId: { type: 'string', description: 'Only sessions whose id contains this substring.' },
      title: { type: 'string', description: 'Only sessions whose title contains this substring (offline titles resolved lazily).' },
      workspaceId: { type: 'string', description: 'Only sessions in this workspace id.' },
      cwd: { type: 'string', description: 'Only sessions whose cwd contains this substring (path or basename).' },
      liveOnly: { type: 'boolean', description: 'When true, only live sessions are returned (default false).' },
      limit: { type: 'number', description: 'Maximum items (default 10, max 50).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<Record<string, unknown>> | null) ?? []
        if (items.length === 0) return [{ type: 'text' as const, text: '(no sessions found)' }]
        const lines = items.map((item) => {
          const id = String(item.sessionId)
          const title = typeof item.title === 'string' ? item.title : '(untitled)'
          const state = item.live === true ? (item.running === true ? 'running' : 'idle') : 'offline'
          const cwd = typeof item.cwd === 'string' ? item.cwd : ''
          return state + ' ' + id + ' (' + title + ')' + (cwd === '' ? '' : ' @ ' + cwd)
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: FindArgs) {
      const limit = clampLimit(args.limit, 10, 50)
      const wsById = workspaceBySession(env.ctx)
      const items: BridgeFindItem[] = []
      for (const agent of liveAgents(env)) {
        const headerCwd = agent.session.header.cwd
        const wsId = wsById.get(agent.id) ?? workspaceByPath(env.ctx, headerCwd)
        items.push({
          sessionId: agent.id,
          title: titleOf(sessionEvents(agent.session)),
          ...(headerCwd === undefined ? {} : { cwd: headerCwd }),
          ...(wsId === undefined ? {} : { workspaceId: wsId }),
          live: true,
          running: agent.status === 'running',
          ...(agent.session.header.parentSession === undefined ? {} : { parentSession: agent.session.header.parentSession }),
          ...(agent.session.header.origin === undefined ? {} : { origin: agent.session.header.origin }),
          createdAt: agent.session.header.createdAt,
          ...(agent.session.header.agentPreset === undefined ? {} : { agentPreset: agent.session.header.agentPreset }),
        })
      }
      if (args.liveOnly !== true) {
        try {
          // dsh >= 0.1.5-alpha.1：list() 返回 { header: SessionHeader, revision, ... } 快照，
          // 不再平铺 id/cwd；旧版直接返回 header 平铺字段。两者都按新形状读，向下兼容。
          const persistence = env.ctx.sessionPersistence as unknown as { list(): Promise<readonly { header: { id: string; cwd?: string; parentSession?: string; origin?: 'subagent'; createdAt: number; agentPreset?: string } }[]> }
          for (const rec of await persistence.list()) {
            const header = rec.header
            if (items.some((item) => item.sessionId === header.id)) continue
            items.push({
              sessionId: header.id,
              ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
              ...(wsById.get(header.id) === undefined ? {} : { workspaceId: wsById.get(header.id) }),
              live: false,
              ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
              ...(header.origin === undefined ? {} : { origin: header.origin }),
              createdAt: header.createdAt,
              ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
            })
          }
        } catch (error) {
          console.warn('[dsh-session-bridge] offline listing failed:', error instanceof Error ? error.message : String(error))
        }
      }
      let registryRecords: Array<{ sessionId: string; title?: string }> = []
      try { registryRecords = await env.registry.all() } catch { registryRecords = [] }
      const bridgeTitles = new Map<string, string>()
      for (const item of items) {
        const rec = registryRecords.find((r) => r.sessionId === item.sessionId)
        if (rec?.title !== undefined) {
          if (item.title === undefined) item.title = rec.title
          bridgeTitles.set(item.sessionId, rec.title)
        }
      }
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const idFilter = typeof args.sessionId === 'string' ? args.sessionId.trim().toLowerCase() : ''
      const titleFilter = typeof args.title === 'string' ? args.title.trim().toLowerCase() : ''
      const wsFilter = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
      const cwdFilter = typeof args.cwd === 'string' ? args.cwd.trim().toLowerCase() : ''
      const needsOfflineTitle = titleFilter !== '' || (query !== '' && items.some((item) => !item.live))
      if (needsOfflineTitle) {
        let inspected = 0
        for (const item of items) {
          if (inspected >= 30) break
          if (item.live || item.title !== undefined) continue
          try {
            const inspection = await inspectPersistedSession(env.ctx, item.sessionId)
            item.title = titleOf(inspection.events)
            inspected += 1
          } catch {
            inspected += 1
          }
        }
      }
      const filtered = items.filter((item) => {
        if (idFilter !== '' && !item.sessionId.toLowerCase().includes(idFilter)) return false
        if (titleFilter !== '') {
          const titles = ((item.title ?? '') + ' ' + (bridgeTitles.get(item.sessionId) ?? '')).toLowerCase()
          if (!titles.includes(titleFilter)) return false
        }
        if (wsFilter !== '' && item.workspaceId !== wsFilter) return false
        if (cwdFilter !== '' && !(item.cwd ?? '').toLowerCase().includes(cwdFilter)) return false
        if (query !== '') {
          const haystack = item.sessionId.toLowerCase() + ' ' + (item.title ?? '').toLowerCase() + ' ' + (item.cwd ?? '').toLowerCase() + ' ' + (bridgeTitles.get(item.sessionId) ?? '').toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      filtered.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1
        return (b.createdAt ?? 0) - (a.createdAt ?? 0)
      })
      return asJson({
        items: filtered.slice(0, limit).map((item) => ({
          sessionId: item.sessionId,
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          ...(item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
          live: item.live,
          ...(item.running === undefined ? {} : { running: item.running }),
          ...(item.parentSession === undefined ? {} : { parentSession: item.parentSession }),
          ...(item.origin === undefined ? {} : { origin: item.origin }),
          ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
          ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
          ...(item.agentPreset === undefined ? {} : { agentPreset: item.agentPreset }),
        })),
        total: filtered.length,
        truncated: filtered.length > limit,
      })
    },
  }))
}

/** 解析一批会话的标题：bridge 登记表的别名优先，其次会话日志里的标题/首条用户消息。 */
async function resolveSessionTitles(env: BridgeEnv, ids: readonly string[]): Promise<Map<string, string | undefined>> {
  const titles = new Map<string, string | undefined>()
  try {
    const records = await env.registry.all()
    for (const rec of records) if (rec.title !== undefined) titles.set(rec.sessionId, rec.title)
  } catch { /* best-effort */ }
  for (const sessionId of ids) {
    if (titles.get(sessionId) !== undefined) continue
    try {
      const inspection = await inspectPersistedSession(env.ctx, sessionId)
      titles.set(sessionId, titleOf(inspection.events))
    } catch { /* offline title unavailable */ }
  }
  return titles
}

interface FavoriteArgs {
  sessionId?: string
  favorite?: boolean
  list?: boolean
  resolveTitles?: boolean
}

/**
 * 收藏 / 取消收藏 / 列出收藏。
 *
 * 与 `workspaceRegistry.pinSession` 的区别是本插件最容易被误解的一点：
 * pin 会把会话顶到列表最前（并禁止归档），而收藏**只**做两件事 ——
 * 在会话行显示 ★、让每小时自动归档跳过它。收藏不改变任何排序。
 */
function registerFavorite(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_favorite',
    description: 'Favorite or unfavorite one session, or list favorites. A favorite is this plugin\'s own marker, NOT workspace pinning: it never reorders sessions and never pins them; it only shows a ★ on the session row in the workspace menu UI and exempts the session from the hourly auto-archive (autoArchive). Unavailable while auto-archive is off: favorites then have no effect and the whole favorites UI is hidden. Omit sessionId (or pass list: true) to list the favorite set; pass sessionId plus favorite: false to remove. Returns lossless JSON only (an unresolvable title is omitted, never written as undefined).',
    parameters: {
      sessionId: { type: 'string', description: 'Session id to favorite or unfavorite. Omit it (or set list: true) to list favorites instead.' },
      favorite: { type: 'boolean', description: 'true favorites the session (default), false removes the favorite.' },
      list: { type: 'boolean', description: 'When true, list the favorite set and ignore sessionId/favorite.' },
      resolveTitles: { type: 'boolean', description: 'When listing, resolve each favorite session\'s title from the bridge registry or its log (default false). Titles are resolved only for the returned ids.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<{ sessionId: string; title?: string }> | null) ?? []
        if (items.length > 0) {
          const lines = items.map((i) => i.sessionId + (i.title === undefined ? '' : ' ("' + i.title + '")'))
          const total = typeof v.total === 'number' ? v.total : items.length
          if (items.length < total) lines.unshift(String(total) + ' favorites; showing ' + String(items.length) + ':')
          return [{ type: 'text' as const, text: lines.join('\n') }]
        }
        if (v.sessionId !== undefined) {
          return [{ type: 'text' as const, text: (v.favorite === true ? 'favorited ' : 'unfavorited ') + String(v.sessionId) + ' (total favorites: ' + String(v.total) + ')' }]
        }
        return [{ type: 'text' as const, text: '(no favorite sessions)' }]
      },
    },
    async execute(args: FavoriteArgs) {
      // 收藏是"跳过自动归档"的标记：自动归档关闭时，收藏 UI（菜单项 / ★ / 设置页收藏区）
      // 与本工具一起下线。这里抛错而不是静默写入，避免"设了收藏、界面里却看不到、也不
      // 产生任何效果"的幽灵状态；开启后原有收藏原样回来。
      if (env.archive.enabled() !== true) {
        throw new Error('session_bridge_favorite is unavailable while auto-archive is off (autoArchive=false) — favorites only exist to exempt sessions from the hourly auto-archive. Enable 设置 → 会话归档 → 自动归档 (or the plugin Config field autoArchive) first.')
      }
      // 列表模式：显式 list:true，或干脆没给 sessionId。
      if (args.list === true || args.sessionId === undefined) {
        const sessionIds = await env.favorites.list()
        if (args.resolveTitles !== true || sessionIds.length === 0) {
          return asJson({ sessionIds, total: sessionIds.length })
        }
        const titles = await resolveSessionTitles(env, sessionIds)
        return asJson({ sessionIds, items: archivedEntries(sessionIds, titles), total: sessionIds.length })
      }
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
        throw new Error('invalid sessionId: expected a non-empty string')
      }
      if (args.favorite !== undefined && typeof args.favorite !== 'boolean') {
        throw new Error('invalid favorite: expected a boolean')
      }
      const favorite = args.favorite !== false
      const snapshot = await env.favorites.set(args.sessionId, favorite)
      return asJson({
        sessionId: args.sessionId,
        favorite,
        sessionIds: snapshot.sessionIds,
        total: snapshot.sessionIds.length,
      })
    },
  }))
}

export function registerBridgeTools(env: BridgeEnv): void {
  registerCreate(env)
  registerSend(env)
  registerResume(env)
  registerWait(env)
  registerSegments(env)
  registerRead(env)
  registerFind(env)
  registerStatus(env)
  registerCancel(env)
  registerMonitor(env)
  registerArchive(env)
  registerFavorite(env)
}

interface MonitorStartArgs {
  sessionId: string
  intervalMs?: number
  stalledMs?: number
  maxStuckCycles?: number
  doneKeywords?: string[]
  useLlm?: boolean
  onStallSteer?: string
  onOffTrackSteer?: string
  label?: string
  coRules?: Array<{ match?: string; field?: string; value?: string; action?: string; message?: string }>
  cotMinHits?: number
  loopGuard?: boolean
  loopField?: string
  loopMinCycles?: number
  loopMinRepeats?: number
  loopMinConfidence?: number
  loopMinHits?: number
  loopCooldownMs?: number
  loopMaxTransfers?: number
  loopTransfer?: boolean
  loopAutoMonitor?: boolean
  loopDescendants?: string
  loopHandoffPrompt?: string
  loopTransferDepth?: number
}

/** 校验并规范化 coRules 参数为 CoTRule[]；非法项抛清晰错误。 */
function parseCoRules(raw: Array<{ match?: string; field?: string; value?: string; action?: string; message?: string }>): CoTRule[] {
  return raw.map((rule, index) => {
    const match = rule.match === 'contains' || rule.match === 'not-contains' ? rule.match : (() => { throw new Error('coRules[' + index + '].match must be "contains" or "not-contains"') })()
    const field = rule.field === 'reasoning' || rule.field === 'text' || rule.field === 'both' ? rule.field : (() => { throw new Error('coRules[' + index + '].field must be "reasoning", "text" or "both"') })()
    const action = rule.action === 'steer' || rule.action === 'cancel' ? rule.action : (() => { throw new Error('coRules[' + index + '].action must be "steer" or "cancel"') })()
    const value = typeof rule.value === 'string' && rule.value.trim() !== '' ? rule.value.trim() : (() => { throw new Error('coRules[' + index + '].value must be a non-empty string') })()
    return {
      match,
      field,
      action,
      value,
      ...(typeof rule.message === 'string' && rule.message.trim() !== '' ? { message: rule.message.trim() } : {}),
    }
  })
}

function renderMonitorState(entry: MonitorEntryState, policy?: LoopPolicy): string[] {
  const lines: string[] = []
  lines.push(`monitoring ${entry.config.sessionId}${entry.config.label === undefined ? '' : ' ("' + entry.config.label + '")'}`)
  lines.push(`interval: ${entry.config.intervalMs}ms | stalled: ${String(entry.config.stalledMs ?? 60000)}ms | maxStuck: ${String(entry.config.maxStuckCycles ?? 3)}`)
  lines.push(`cycles: ${entry.cycles} | stuck: ${entry.stuckCount} | lastAction: ${entry.lastAction}`)
  const cotCount = (entry.config.coTRules ?? []).length
  if (cotCount > 0) lines.push(`coRules: ${cotCount} rule(s) (minHits ${String(entry.config.cotMinHits ?? 1)})`)
  if (entry.config.loopGuard === false) {
    lines.push('loopGuard: off (this monitor only)')
  } else if (policy !== undefined && !policy.enabled()) {
    lines.push('loopGuard: off (plugin switch — /cot-loop on, or Settings → Plugins → dsh-session-bridge)')
  } else {
    const loopState = entry.loop
    const transfers = loopState === undefined ? [] : loopState.transfers
    const depth = entry.config.loopTransferDepth ?? 0
    const path = transfers.length === 0 ? '' : ' (' + transfers.map((t) => t.from + ' → ' + t.to).join(', ') + ')'
    lines.push(`loopGuard: on field=${entry.config.loopField ?? 'reasoning'} ${String(entry.config.loopMinCycles ?? 2)}x${String(entry.config.loopMinRepeats ?? 3)} conf>=${String(entry.config.loopMinConfidence ?? 0.6)} descendants=${entry.config.loopDescendants ?? 'report'}${depth === 0 ? '' : ' depth=' + String(depth)}`
      + ` | transfers: ${transfers.length}${path}, subagent cancels: ${String(loopState === undefined ? 0 : loopState.subagentCancels)}`)
  }
  if (entry.lastNote !== '') lines.push(`note: ${entry.lastNote}`)
  if (entry.done) lines.push('done: yes')
  return lines
}

function registerMonitor(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_monitor_start',
    description: 'Start a background watchdog on a main session: poll its progress at an interval, and automatically schedule — steer the session when it stalls (or, with useLlm, when it drifts off-track), cancel it when it stays stuck past maxStuckCycles, and stop when a done keyword appears while idle. It can also enforce chain-of-thought rules via coRules: e.g. coRules=[{match:"not-contains",field:"reasoning",value:"I\'m",action:"cancel"}] stops the session the moment its live reasoning stops containing I\'m (evaluated on each poll while running). This is the "monitor worker" that watches a main task thread and corrects/stops it. Uses session_bridge_status-style facts; pass sessionId of a live session. Returns the watchdog state.'
      + ' It also detects chain-of-thought LOOPS by default — the same content repeated over and over (e.g. "写。好。Go。写。好。Go。写。好。Go。"). A stall check cannot catch this (every cycle lands new events, so the target never looks stalled), so on a loop the watchdog interrupts the session and TRANSFERS the task to a new session, which receives a handoff prompt (original session id, task, recent context, and the descendant list) and is watched by default. Subagents: still-running descendants are left running and listed in the handoff (default loopDescendants="report" — never cancelled), loopDescendants="stop" cancels them before transferring, "ignore" drops them. A subagent session that loops is only cancelled, never transferred (that would break the execution tree). Knobs: loopGuard, loopField (reasoning|text|both), loopMinCycles, loopMinRepeats, loopMinConfidence, loopMinHits, loopCooldownMs, loopMaxTransfers (default 3, also the transfer-depth cap), loopTransfer, loopAutoMonitor, loopDescendants, loopHandoffPrompt, loopTransferDepth. A PLUGIN-LEVEL switch (config field loopGuard, toggled with the /cot-loop slash command or Settings → Plugins → dsh-session-bridge) disables loop detection for every monitor at once; passing loopGuard=false here does the same for this monitor alone.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target main session id to watch (must be live).' },
      intervalMs: { type: 'number', description: 'Poll interval in ms (default 10000, min 5000).' },
      stalledMs: { type: 'number', description: 'Treat as stalled when no event for this many ms (default 60000).' },
      maxStuckCycles: { type: 'number', description: 'Cancel the session after this many consecutive stall ticks (default 3).' },
      doneKeywords: { type: 'array', items: { type: 'string' }, description: 'Any of these strings in the reply (while idle) marks the task done and stops the watchdog.' },
      useLlm: { type: 'boolean', description: 'When true, use the LLM to also detect off-track (default false, rules only).' },
      onStallSteer: { type: 'string', description: 'Steer text injected on a stall/nudge (default: ask to summarize progress and continue).' },
      onOffTrackSteer: { type: 'string', description: 'Steer text injected when LLM judges the task off-track (default: ask to return to the original goal).' },
      label: { type: 'string', description: 'Optional human label for logs/display.' },
      coRules: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        match: { type: 'string', required: true, enum: ['contains', 'not-contains'], description: 'contains = must include value in the chosen field; not-contains = must NOT include it.' },
        field: { type: 'string', required: true, enum: ['reasoning', 'text', 'both'], description: 'Match on reasoning (chain-of-thought), text (reply), or both (either).' },
        value: { type: 'string', required: true, description: 'The substring to match (non-empty).' },
        action: { type: 'string', required: true, enum: ['steer', 'cancel'], description: 'steer injects a guiding message; cancel terminates the session.' },
        message: { type: 'string', description: 'Custom steer text (default is a guidance prompt).' },
      } }, description: 'Chain-of-thought rules: when a rule stays matched for cotMinHits consecutive polls (default 1), trigger its action. Example: [{match:"not-contains",field:"reasoning",value:"I\'m",action:"cancel"}] stops the session the moment its live reasoning no longer contains I\'m.' },
      cotMinHits: { type: 'number', description: 'How many consecutive matched polls before a CoT rule fires (default 1 = immediately).' },
      loopGuard: { type: 'boolean', description: 'Chain-of-thought LOOP detection with automatic task transfer: false disables it (default true).' },
      loopField: { type: 'string', enum: ['reasoning', 'text', 'both'], description: 'Which field to scan for loops (default reasoning = live chain-of-thought).' },
      loopMinCycles: { type: 'number', description: 'Minimum number of repeated cycles (default 2).' },
      loopMinRepeats: { type: 'number', description: 'Minimum repeats of the unit (default 3); the effective floor is max(loopMinCycles, loopMinRepeats).' },
      loopMinConfidence: { type: 'number', description: 'Confidence threshold 0..1 (default 0.6).' },
      loopMinHits: { type: 'number', description: 'Consecutive polls with the same loop signature before firing (default 1 = first hit).' },
      loopCooldownMs: { type: 'number', description: 'Cooldown in ms before the same signature may fire again (default max(intervalMs*2, 30000)).' },
      loopMaxTransfers: { type: 'number', description: 'Max task transfers (default 3); also the transfer-depth cap.' },
      loopTransfer: { type: 'boolean', description: 'When false a detected loop only cancels the session (default true = transfer the task to a new session).' },
      loopAutoMonitor: { type: 'boolean', description: 'When false the newly created successor session is not watched (default true).' },
      loopDescendants: { type: 'string', enum: ['report', 'stop', 'ignore'], description: 'Subagent policy: report (default) lists running subagents in the handoff and leaves them running; stop cancels them before transferring; ignore drops them entirely.' },
      loopHandoffPrompt: { type: 'string', description: 'Custom handoff prompt template. Placeholders: {{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}.' },
      loopTransferDepth: { type: 'number', description: 'Current transfer depth (internal; the watchdog passes depth+1 to the successor session).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const entry = v.monitor as MonitorEntryState | null
        if (entry === null || entry === undefined) return [{ type: 'text' as const, text: 'monitor not started' }]
        return [{ type: 'text' as const, text: renderMonitorState(entry, env.policy).join('\n') }]
      },
    },
    async execute(args: MonitorStartArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const config: MonitorConfig = {
        sessionId: args.sessionId.trim(),
        intervalMs: typeof args.intervalMs === 'number' && args.intervalMs >= 5000 ? Math.floor(args.intervalMs) : 10000,
        ...(typeof args.stalledMs === 'number' && args.stalledMs > 0 ? { stalledMs: Math.floor(args.stalledMs) } : {}),
        ...(typeof args.maxStuckCycles === 'number' && args.maxStuckCycles >= 1 ? { maxStuckCycles: Math.floor(args.maxStuckCycles) } : {}),
        doneKeywords: Array.isArray(args.doneKeywords) ? args.doneKeywords.filter((k) => typeof k === 'string' && k.trim() !== '') : [],
        ...(args.useLlm === true ? { useLlm: true } : {}),
        ...(typeof args.onStallSteer === 'string' && args.onStallSteer.trim() !== '' ? { onStallSteer: args.onStallSteer.trim() } : {}),
        ...(typeof args.onOffTrackSteer === 'string' && args.onOffTrackSteer.trim() !== '' ? { onOffTrackSteer: args.onOffTrackSteer.trim() } : {}),
        ...(typeof args.label === 'string' && args.label.trim() !== '' ? { label: args.label.trim() } : {}),
        ...(Array.isArray(args.coRules) && args.coRules.length > 0 ? { coTRules: parseCoRules(args.coRules) } : {}),
        ...(typeof args.cotMinHits === 'number' && Number.isInteger(args.cotMinHits) && args.cotMinHits >= 1 ? { cotMinHits: Math.floor(args.cotMinHits) } : {}),
        ...(args.loopGuard === false ? { loopGuard: false } : {}),
        ...(args.loopField === 'reasoning' || args.loopField === 'text' || args.loopField === 'both' ? { loopField: args.loopField } : {}),
        ...(typeof args.loopMinCycles === 'number' ? { loopMinCycles: Math.floor(args.loopMinCycles) } : {}),
        ...(typeof args.loopMinRepeats === 'number' ? { loopMinRepeats: Math.floor(args.loopMinRepeats) } : {}),
        ...(typeof args.loopMinConfidence === 'number' ? { loopMinConfidence: args.loopMinConfidence } : {}),
        ...(typeof args.loopMinHits === 'number' ? { loopMinHits: Math.floor(args.loopMinHits) } : {}),
        ...(typeof args.loopCooldownMs === 'number' ? { loopCooldownMs: Math.floor(args.loopCooldownMs) } : {}),
        ...(typeof args.loopMaxTransfers === 'number' ? { loopMaxTransfers: Math.floor(args.loopMaxTransfers) } : {}),
        ...(args.loopTransfer === false ? { loopTransfer: false } : {}),
        ...(args.loopAutoMonitor === false ? { loopAutoMonitor: false } : {}),
        ...(args.loopDescendants === 'report' || args.loopDescendants === 'stop' || args.loopDescendants === 'ignore' ? { loopDescendants: args.loopDescendants } : {}),
        ...(typeof args.loopHandoffPrompt === 'string' && args.loopHandoffPrompt.trim() !== '' ? { loopHandoffPrompt: args.loopHandoffPrompt } : {}),
        ...(typeof args.loopTransferDepth === 'number' ? { loopTransferDepth: Math.floor(args.loopTransferDepth) } : {}),
      }
      const entry = env.monitor.start(config)
      env.registry.touch(args.sessionId)
      return asJson({ sessionId: args.sessionId, monitor: { ...entry, config: { ...entry.config } } })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_bridge_monitor_stop',
    description: 'Stop the background watchdog on a session (keep the session itself running). Returns whether a watchdog was active and stopped.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: (v.wasActive === true ? 'stopped monitor ' : 'no active monitor ') + String(v.sessionId) }]
      },
    },
    async execute(args: { sessionId: string }) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const wasActive = env.monitor.stop(args.sessionId.trim())
      return asJson({ sessionId: args.sessionId, wasActive })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_bridge_monitor_list',
    description: 'List all active watchdogs started via session_bridge_monitor_start, with their poll interval, stall threshold, stuck count, last action, and done status.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const entries = (v.monitors as MonitorEntryState[] | null) ?? []
        if (entries.length === 0) return [{ type: 'text' as const, text: '(no active monitors)' }]
        return [{ type: 'text' as const, text: entries.map((e) => renderMonitorState(e, env.policy).join('\n')).join('\n---\n') }]
      },
    },
    async execute() {
      const monitors = env.monitor.list().map((e) => ({ ...e, config: { ...e.config } }))
      return asJson({ monitors })
    },
  }))
}

type StatusReasoning = 'none' | 'last' | 'live' | 'tail'

interface StatusArgs {
  sessionId: string
  stalledMsThreshold?: number
  recent?: number
  reasoning?: StatusReasoning
}

/** 按 reasoning 选项裁剪快照里的思维链字段（避免入 token 时有 diff 语义差）。 */
function pruneReasoning(snapshot: BridgeStatusSnapshot, mode: StatusReasoning): BridgeStatusSnapshot {
  if (mode === 'tail') return snapshot
  const rest: BridgeStatusSnapshot = { ...snapshot }
  delete (rest as { reasoningTail?: unknown }).reasoningTail
  if (mode === 'none') {
    delete (rest as { lastReasoning?: unknown }).lastReasoning
    delete (rest as { liveReasoning?: unknown }).liveReasoning
  } else if (mode === 'last') {
    delete (rest as { liveReasoning?: unknown }).liveReasoning
  } else { // 'live'
    delete (rest as { lastReasoning?: unknown }).lastReasoning
  }
  return rest
}

/**
 * 渲染监控快照为一行摘要：运行态 + openTurn + 卡住/待处理 + 最新回复(+ 思维链预览)。
 * 卡住判定走 core.isStalled（唯一真源）：只有 running 会话才可能被标 [STALLED] ——
 * 空闲/已收尾的会话"很久没事件"是正常状态，不是卡住（与监控 watchdog 一致）。
 */
function renderStatus(snapshot: BridgeStatusSnapshot, stalledMsThreshold: number): string[] {
  const lines: string[] = []
  const runLabel = snapshot.running === 'running' ? 'running' : 'idle'
  lines.push(`${runLabel} ${snapshot.sessionId}${snapshot.title === undefined ? '' : ` ("${snapshot.title}")`}`)
  if (snapshot.openTurn) lines.push(`openTurn: yes (turn #${snapshot.lastTurn})`)
  else lines.push(`openTurn: no (last turn #${snapshot.lastTurn})`)
  if (snapshot.stalledMs !== null) {
    const stalled = isStalled(snapshot.running, snapshot.stalledMs, stalledMsThreshold)
    lines.push(`lastActivity: now-${snapshot.stalledMs}ms${stalled ? ' [STALLED]' : ''}`)
  }
  if (snapshot.pendingWork) lines.push(`pendingWork: ${snapshot.nextTurnCount} turn + ${snapshot.nextStepCount} step`)
  if (snapshot.lastAssistantText !== undefined) lines.push(`lastReply: ${snapshot.lastAssistantText}`)
  if (snapshot.reasoningTail !== undefined && snapshot.reasoningTail !== '') {
    const preview = snapshot.reasoningTail.length > 160 ? snapshot.reasoningTail.slice(0, 160) + '…' : snapshot.reasoningTail
    lines.push(`reasoning: ${preview}`)
  }
  return lines
}

function registerStatus(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_status',
    description: 'Inspect a session\'s live progress for monitoring/scheduling. Returns running/idle, whether a turn is open, last turn number, time since the last event (for stall detection), pending queued work, and the latest text reply. It also surfaces the session\'s chain-of-thought: lastReasoning is the most recent finalized reasoning block, liveReasoning is the in-flight reasoning streamed for the current handled turn (reasoning-delta), and reasoningTail is a compact merged preview. reasoning=none drops all three to keep tokens small. When stalledMsThreshold is given, marks a RUNNING session as stalled once the time since the last event exceeds it (idle sessions are never flagged — a quiet finished session is not stuck). Pass sessionId of a live session (use session_bridge_find to locate; session_bridge_resume to bring an offline one online). Use this as the "observe" step of a monitor→decide→steer/cancel loop.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to inspect (must be live).' },
      stalledMsThreshold: { type: 'number', description: 'Mark a RUNNING session STALLED when time since the last event exceeds this many ms (default 60000); idle sessions are never marked.' },
      recent: { type: 'number', description: 'Number of recent messages to include in the snapshot (default 8, max 20).' },
      reasoning: { type: 'string', enum: ['none', 'last', 'live', 'tail'], description: 'Which chain-of-thought fields to include: tail (default) returns lastReasoning/liveReasoning/reasoningTail; last only the finalized reasoning; live only the in-flight reasoning; none drops all reasoning fields.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const snapshot = v.snapshot as BridgeStatusSnapshot | null
        if (snapshot === null || snapshot === undefined) return [{ type: 'text' as const, text: 'session unavailable' }]
        const threshold = typeof v.stalledMsThreshold === 'number' ? v.stalledMsThreshold : 60000
        return [{ type: 'text' as const, text: renderStatus(snapshot, threshold).join('\n') }]
      },
    },
    async execute(args: StatusArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_bridge_resume first (status requires a live session)')
      }
      const threshold = typeof args.stalledMsThreshold === 'number' && Number.isFinite(args.stalledMsThreshold) && args.stalledMsThreshold >= 0 ? args.stalledMsThreshold : 60000
      const reasoningMode: StatusReasoning = args.reasoning === 'none' || args.reasoning === 'last' || args.reasoning === 'live' ? args.reasoning : 'tail'
      const snapshot = pruneReasoning(statusSnapshot(env.ctx, agent), reasoningMode)
      const shown = typeof args.recent === 'number' && Number.isInteger(args.recent) && args.recent >= 0 ? Math.min(args.recent, 20) : 8
      const envCwd = agent.session.header.cwd
      env.registry.touch(args.sessionId, {
        ...(envCwd === undefined ? {} : { cwd: envCwd }),
        ...(workspaceByPath(env.ctx, envCwd) === undefined ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }),
      })
      return asJson({
        sessionId: args.sessionId,
        stalledMsThreshold: threshold,
        snapshot: {
          ...snapshot,
          recent: snapshot.recent.slice(-shown).map((row) => ({ ...row })),
        },
      })
    },
  }))
}

interface CancelArgs {
  sessionId: string
  keepInbox?: boolean
  cause?: string
}

function registerCancel(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_cancel',
    description: 'Stop a running session: abort the active turn (and if keepInbox is false, also clear queued/steering work). Mirrors the agent cancel primitive. Use this as the "stop" step of a monitor→decide loop when a task has gone wrong, is stuck, or should be terminated. Returns the session state after cancellation. To resume later use session_bridge_resume; to re-queue work use session_bridge_send.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to cancel (must be live).' },
      keepInbox: { type: 'boolean', description: 'Preserve queued/steering input instead of clearing it (default false, i.e. clear pending work).' },
      cause: { type: 'string', description: 'Optional stable reason recorded for the cancellation.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: 'cancelled ' + String(v.sessionId) + ' (running: ' + String(v.running) + (v.keepInbox === true ? ', inbox kept' : ', inbox cleared') + ')' }]
      },
    },
    async execute(args: CancelArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_bridge_resume first (cancel requires a live session)')
      }
      const cause = typeof args.cause === 'string' && args.cause.trim() !== ''
        ? { kind: 'hook', reason: args.cause.trim() }
        : { kind: 'user' }
      agent.cancel(cause, { keepInbox: args.keepInbox === true })
      const snapshot = statusSnapshot(env.ctx, agent)
      const envCwd = agent.session.header.cwd
      env.registry.touch(args.sessionId, {
        ...(envCwd === undefined ? {} : { cwd: envCwd }),
        ...(workspaceByPath(env.ctx, envCwd) === undefined ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }),
      })
      return asJson({
        sessionId: args.sessionId,
        running: agent.status,
        keepInbox: args.keepInbox === true,
        snapshot,
      })
    },
  }))
}

interface ArchiveArgs {
  sessionId: string
  stopActivity?: boolean
}

/** How many archived ids a tool result echoes before it summarizes the rest. */
const ARCHIVE_ECHO_LIMIT = 20

/**
 * 紧凑渲染归档集合：归档集合会无限增长（真实宿主里已有 200+ 个），而每次
 * archive/unarchive 都把整集合回显到工具结果里，会把真正的结果埋进数千 token
 * 的 id 列表里（实测单次约 4k token）。这里只回显最新的一段，`total` 始终给出
 * 准确规模；需要完整列表时用 `session_bridge_archived`（可传 limit）。
 */
function renderArchived(ids: readonly string[]): string {
  const total = 'total archived: ' + String(ids.length)
  if (ids.length === 0) return total + ' (empty)'
  const shown = ids.slice(-ARCHIVE_ECHO_LIMIT)
  const omitted = ids.length - shown.length
  return total + '\nmost recent: ' + shown.join(', ') + (omitted > 0 ? ' … (+' + String(omitted) + ' earlier omitted)' : '')
}

function registerArchive(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_archive',
    description: 'Archive one session: add it to the workspace registry\'s global archive set so it is hidden from every grouping surface in the UI (Un/grouped, workspaces) while its session history and workspace position are preserved. Mirrors the workspace controller archiveSession. The session must exist (live or in session persistence) and, without stopActivity, must be inactive — otherwise the archive is refused with "the session is active". Returns the affected session id and the resulting archive size (the newest ids only; use session_bridge_archived for a listing).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to archive.' },
      stopActivity: { type: 'boolean', description: 'When true, stop the session\'s running work (turn, subagents, jobs, schedules) instead of refusing the archive because work is active (default false). The archive is written first and the stops are requested afterwards, exactly like the UI archive action.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const note = v.stopActivity === true ? ' (stopped running work)' : ''
        return [{ type: 'text' as const, text: 'archived ' + String(v.sessionId) + note + '\n' + renderArchived((v.archivedSessionIds as string[] | undefined) ?? []) }]
      },
    },
    async execute(args: ArchiveArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sessionId = args.sessionId.trim()
      const stopActivity = args.stopActivity === true
      try {
        // `stopActivity` is the official escape hatch for a session whose work is
        // still running: without it the registry refuses the archive with
        // WorkspaceActiveSessionError, which made archiving a live target
        // impossible through the bridge.
        await env.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, stopActivity ? { stopActivity: true } : undefined)
      } catch (error) {
        const hint = stopActivity ? '' : ' (pass stopActivity: true to archive it anyway and stop its running work)'
        throw new Error('cannot archive session ' + JSON.stringify(sessionId) + ': ' + (error instanceof Error ? error.message : String(error)) + hint)
      }
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      return asJson({ sessionId, stopActivity, archivedSessionIds: archived, totalArchived: archived.length })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_bridge_unarchive',
    description: 'Unarchive one session: drop it from the workspace registry\'s global archive set so it is visible again on every grouping surface at its recorded position (its workspace accounting is never touched by archiving, so the slot is still there). Mirrors the workspace controller unarchiveSession. An unknown or not-archived id is an idempotent no-op. Returns the affected session id and the resulting archive size (the newest ids only; use session_bridge_archived for a listing).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to unarchive.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: 'unarchived ' + String(v.sessionId) + '\n' + renderArchived((v.archivedSessionIds as string[] | undefined) ?? []) }]
      },
    },
    async execute(args: ArchiveArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sessionId = args.sessionId.trim()
      try {
        await env.ctx.workspaceRegistry.unarchiveSession(sessionId as SessionId)
      } catch (error) {
        throw new Error('cannot unarchive session ' + JSON.stringify(sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
      }
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      return asJson({ sessionId, archivedSessionIds: archived, totalArchived: archived.length })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_bridge_archived',
    description: 'List the session ids currently in the workspace registry archive set (hidden from groupings). Optionally resolve titles from the session log. The newest `limit` ids are returned (default 50, max 500) because the archive set grows without bound; `total` always reports the real size. Read-only.',
    parameters: {
      resolveTitles: { type: 'boolean', description: 'When true, resolve each archived session\'s title from its log (default false). Titles are resolved only for the returned ids.' },
      limit: { type: 'number', description: 'Maximum ids to return, taken from the newest end of the archive set (default 50, max 500).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<{ sessionId: string; title?: string }> | null) ?? []
        if (items.length === 0) return [{ type: 'text' as const, text: '(no archived sessions)' }]
        const total = typeof v.total === 'number' ? v.total : items.length
        const lines = items.map((i) => i.sessionId + (i.title === undefined ? '' : ' ("' + i.title + '")'))
        if (items.length < total) lines.unshift(String(total) + ' archived; newest ' + String(items.length) + ':')
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: { resolveTitles?: boolean; limit?: number }) {
      const limit = clampLimit(args.limit, 50, 500)
      const all = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      // 最新在尾部：截尾返回最新的一段，与 archive/unarchive 的回显方向一致。
      const archived = all.slice(-limit)
      if (args.resolveTitles !== true || archived.length === 0) {
        return asJson({ items: archivedEntries(archived, new Map()), returned: archived.length, total: all.length })
      }
      // 标题来源优先级：bridge 登记表里的别名 > 会话日志里的标题/首条用户消息。
      // 解析不出来的会话就**不带** title 字段返回（绝不写 undefined —— 那会让整个
      // 工具返回值不再是 lossless JSON，宿主会拒绝它，标题缺失不该升级成整体失败）。
      // 只解析返回的这段 id：集合可能有几百个，逐个读日志会拖垮工具调用。
      const titles = await resolveSessionTitles(env, archived)
      return asJson({ items: archivedEntries(archived, titles), returned: archived.length, total: all.length })
    },
  }))
}

