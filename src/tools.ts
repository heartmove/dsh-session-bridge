/**
 * dsh-session-bridge 模型面向工具：create / send / resume / wait / read / find。
 * 全部经插件宿主 ctx 操作真实 DSH 会话（顶层主会话与任意其它会话）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as agentApi from '@deepseek-ai/dsh-agent'
import type {
  BridgeFindItem,
  BridgeMessageRow,
  BridgeStatusSnapshot,
  BridgeWaitResult,
  LiveAgentLike,
  WaitForReplyOptions,
} from './core.ts'
import {
  attachSessionToWorkspace,
  foldMessages,
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
import type { BridgeRegistry } from './registry.ts'
import type { SessionMonitor, MonitorConfig, MonitorEntryState, CoTRule } from './monitor.ts'

type SessionIdBrand = { readonly __sessionIdBrand?: never }

export interface BridgeEnv {
  ctx: Context
  registry: BridgeRegistry
  monitor: SessionMonitor
}

interface ModelSelectionRef {
  current: { provider?: string; model?: string; reasoningEffort?: string } | undefined
  assembled?: undefined
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
    aborted: wait.aborted,
    waitedMs: wait.waitedMs,
  }
}

/** 等待参数（send/create 共用）。 */
interface WaitArgs {
  waitForReply?: boolean
  timeoutMs?: number
}

async function maybeWait(env: BridgeEnv, session: { events: readonly SessionEvent[] }, baselineSeq: number, args: WaitArgs, signal: AbortSignal): Promise<ReturnType<typeof renderWait> | undefined> {
  if (args.waitForReply !== true) return undefined
  const result = await waitForReply({
    session: session as WaitForReplyOptions['session'],
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
        if (reply !== undefined) {
          lines.push(`reply: ${String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)')}`)
          if (reply.timedOut === true) lines.push('[wait timed out]')
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: CreateArgs, exec) {
      const caller = exec.agent as LiveAgentLike | undefined
      const callerCwd = caller?.session.header.cwd
      const targetCwd = await resolveTargetCwd(env.ctx, callerCwd, args)
      const callerHeader = caller?.session.requestHeader?.()
      const provider = typeof args.provider === 'string' && args.provider !== '' ? args.provider : callerHeader?.config?.provider ?? ''
      const model = typeof args.model === 'string' && args.model !== '' ? args.model : callerHeader?.config?.model ?? ''
      const reasoningEffort = typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '' ? args.reasoningEffort : callerHeader?.config?.reasoningEffort

      const selection: ModelSelectionRef = {
        current: {
          ...(provider !== '' ? { provider } : {}),
          ...(model !== '' ? { model } : {}),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }
      }
      const installModelSelection = (agentApi as unknown as { installModelSelection?: (agentCtx: Context, selection: ModelSelectionRef) => () => void }).installModelSelection

      const sessionId = `sb-${randomUUID()}`
      const agents = env.ctx.agents as unknown as {
        create(options: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; agentOptions?: Record<string, unknown>; setup?: (agentCtx: Context) => void }): Promise<{ agent: LiveAgentLike }>
      }
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: targetCwd,
          ...(typeof args.agentPreset === 'string' && args.agentPreset.trim() !== '' ? { agentPreset: args.agentPreset.trim() } : {}),
        },
        agentOptions: {
          ...(provider !== '' ? { provider } : {}),
          ...(model !== '' ? { model } : {}),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
        setup: (agentCtx: Context) => {
          if (caller !== undefined) {
            const presets = env.ctx.agentPresets as unknown as { composeFrom(agentCtx: Context, parentCtx: Context): string | undefined }
            presets.composeFrom(agentCtx, caller.ctx)
          }
          if (installModelSelection !== undefined) {
            installModelSelection(agentCtx, selection)
            return
          }
          // fallback: rewrite the request config only (model selection split is acceptable)
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
      const workspaceId = await attachSessionToWorkspace(env.ctx, sessionId as SessionId, targetCwd) ?? workspaceByPath(env.ctx, targetCwd)
      env.registry.record({
        sessionId,
        ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title.trim() } : {}),
        cwd: targetCwd,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(provider !== '' ? { provider } : {}),
        ...(model !== '' ? { model } : {}),
        source: 'create',
      })

      let reply: ReturnType<typeof renderWait> | undefined
      if (typeof args.prompt === 'string' && args.prompt.trim() !== '') {
        const baseline = maxSeq(sessionEvents(agent.session))
        agent.followup(userMessage(args.prompt.trim()))
        env.registry.touch(sessionId)
        if (args.waitForReply === true) {
          reply = await maybeWait(env, agent.session, baseline, args, exec.signal)
        }
      }

      return asJson({
        sessionId,
        cwd: targetCwd,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title.trim() } : {}),
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
        if (reply !== null && reply !== undefined) {
          lines.push('reply: ' + String((reply.message as Record<string, unknown> | null)?.text ?? '(no text)'))
          if ((reply as Record<string, unknown>).timedOut === true) lines.push('[wait timed out]')
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
      return asJson({ accepted: true, sessionId: args.sessionId, ...(reply === undefined ? {} : { reply }) })
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
        const persistence = env.ctx.sessionPersistence as unknown as { list(): Promise<readonly { id: string; cwd?: string; createdAt: number }[]> }
        headers = await persistence.list()
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
    description: 'Wait for a session next assistant output: blocks (polling the session log) until a NEW assistant output appears after sinceSeq (default: the latest seq at call time). waitFor=reply returns as soon as a new assistant TEXT reply is readable; waitFor=segment returns as soon as any new COMPLETED output segment appears (an assistant/message step — text, reasoning, or tool-call turn), i.e. it does NOT wait for the whole turn, so you can observe the chain-of-thought/output paragraph by paragraph as it is produced. Returns the output summary, or timedOut/aborted when the deadline or caller cancellation ends the wait. Use it to consume output produced asynchronously by another session (e.g. a session you sent a message to, or one working on its own).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to wait on.' },
      sinceSeq: { type: 'number', description: 'Only replies after this event seq count (default: latest seq at call time).' },
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
        const lines = ['reply seq ' + String(reply.seq) + ': ' + String(message === null ? '(no text)' : message.text ?? '(no text)')]
        if (typeof reply.turnEnded === 'boolean') lines.push('turnEnded: ' + String(reply.turnEnded))
        if (reply.timedOut === true) lines.push('[wait timed out]')
        if (reply.aborted === true) lines.push('[wait aborted]')
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args: WaitArgsTool, exec) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const agent = liveAgent(env, args.sessionId)
      if (agent === undefined) {
        throw new Error('session ' + JSON.stringify(args.sessionId) + ' is not live — call session_bridge_resume first (waiting requires a live session)')
      }
      // 默认 baseline = 当前最后一条（带文本的）assistant 行的 seq：让 wait 只等待
      // 之后新出现的输出，避免把"已存在的输出"当成待等内容，同时不被文本后追加的
      // 无文本中间块（推理尾块/工具结果）干扰。segment 模式下以最后一个已完成段落为界。
      const waitSegment = args.waitFor === 'segment'
      let baseline: number
      if (typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0) {
        baseline = args.sinceSeq
      } else if (waitSegment) {
        const segs = segmentsSince(sessionEvents(agent.session))
        baseline = segs.length === 0 ? -1 : (segs[segs.length - 1]?.seq ?? -1)
      } else {
        let lastText = -1
        for (const row of foldMessages(sessionEvents(agent.session))) {
          if (row.text !== undefined) lastText = row.seq
        }
        baseline = lastText
      }
      const result = await waitForReply({
        session: agent.session,
        baselineSeq: baseline,
        timeoutMs: clampTimeout(args.timeoutMs),
        signal: exec.signal,
        requireTurnEnd: args.requireTurnEnd === true,
        ...(waitSegment ? { waitForSegment: true } : {}),
      })
      env.registry.touch(args.sessionId)
      return asJson({
        sessionId: args.sessionId,
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
          const persistence = env.ctx.sessionPersistence as unknown as { inspect(id: string): Promise<{ events: readonly SessionEvent[] }> }
          const inspection = await persistence.inspect(args.sessionId)
          events = inspection.events
          live = false
        } catch (error) {
          throw new Error(String(error))
        }
      }
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : 0
      const limit = clampLimit(args.limit, 10, 50)
      const segs = segmentsSince(events, sinceSeq)
      env.registry.touch(args.sessionId)
      const nextCursorSeq = segs.length === 0 ? sinceSeq : (segs[segs.length - 1]?.seq ?? sinceSeq)
      return asJson({
        sessionId: args.sessionId,
        live,
        nextCursorSeq,
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
          const persistence = env.ctx.sessionPersistence as unknown as { inspect(id: string): Promise<{ events: readonly SessionEvent[]; meta: { cwd?: string } }> }
          inspection = await persistence.inspect(args.sessionId)
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
          const persistence = env.ctx.sessionPersistence as unknown as { list(): Promise<readonly { id: string; cwd?: string; parentSession?: string; origin?: 'subagent'; createdAt: number; agentPreset?: string }[]> }
          for (const header of await persistence.list()) {
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
        const persistence = env.ctx.sessionPersistence as unknown as { inspect(id: string): Promise<{ events: readonly SessionEvent[] }> }
        let inspected = 0
        for (const item of items) {
          if (inspected >= 30) break
          if (item.live || item.title !== undefined) continue
          try {
            const inspection = await persistence.inspect(item.sessionId)
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

function renderMonitorState(entry: MonitorEntryState): string[] {
  const lines: string[] = []
  lines.push(`monitoring ${entry.config.sessionId}${entry.config.label === undefined ? '' : ' ("' + entry.config.label + '")'}`)
  lines.push(`interval: ${entry.config.intervalMs}ms | stalled: ${String(entry.config.stalledMs ?? 60000)}ms | maxStuck: ${String(entry.config.maxStuckCycles ?? 3)}`)
  lines.push(`cycles: ${entry.cycles} | stuck: ${entry.stuckCount} | lastAction: ${entry.lastAction}`)
  const cotCount = (entry.config.coTRules ?? []).length
  if (cotCount > 0) lines.push(`coRules: ${cotCount} rule(s) (minHits ${String(entry.config.cotMinHits ?? 1)})`)
  if (entry.lastNote !== '') lines.push(`note: ${entry.lastNote}`)
  if (entry.done) lines.push('done: yes')
  return lines
}

function registerMonitor(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_monitor_start',
    description: 'Start a background watchdog on a main session: poll its progress at an interval, and automatically schedule — steer the session when it stalls (or, with useLlm, when it drifts off-track), cancel it when it stays stuck past maxStuckCycles, and stop when a done keyword appears while idle. It can also enforce chain-of-thought rules via coRules: e.g. coRules=[{match:"not-contains",field:"reasoning",value:"I\'m",action:"cancel"}] stops the session the moment its live reasoning stops containing I\'m (evaluated on each poll while running). This is the "monitor worker" that watches a main task thread and corrects/stops it. Uses session_bridge_status-style facts; pass sessionId of a live session. Returns the watchdog state.',
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
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const entry = v.monitor as MonitorEntryState | null
        if (entry === null || entry === undefined) return [{ type: 'text' as const, text: 'monitor not started' }]
        return [{ type: 'text' as const, text: renderMonitorState(entry).join('\n') }]
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
        return [{ type: 'text' as const, text: entries.map((e) => renderMonitorState(e).join('\n')).join('\n---\n') }]
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

/** 渲染监控快照为一行摘要：运行态 + openTurn + 卡住/待处理 + 最新回复(+ 思维链预览)。 */
function renderStatus(snapshot: BridgeStatusSnapshot, stalledMsThreshold: number): string[] {
  const lines: string[] = []
  const runLabel = snapshot.running === 'running' ? 'running' : 'idle'
  lines.push(`${runLabel} ${snapshot.sessionId}${snapshot.title === undefined ? '' : ` ("${snapshot.title}")`}`)
  if (snapshot.openTurn) lines.push(`openTurn: yes (turn #${snapshot.lastTurn})`)
  else lines.push(`openTurn: no (last turn #${snapshot.lastTurn})`)
  if (snapshot.stalledMs !== null) {
    const stalled = snapshot.stalledMs >= stalledMsThreshold
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
    description: 'Inspect a session\'s live progress for monitoring/scheduling. Returns running/idle, whether a turn is open, last turn number, time since the last event (for stall detection), pending queued work, and the latest text reply. It also surfaces the session\'s chain-of-thought: lastReasoning is the most recent finalized reasoning block, liveReasoning is the in-flight reasoning streamed for the current handled turn (reasoning-delta), and reasoningTail is a compact merged preview. reasoning=none drops all three to keep tokens small. When stalledMsThreshold is given, marks the session as stalled when the time since the last event exceeds it. Pass sessionId of a live session (use session_bridge_find to locate; session_bridge_resume to bring an offline one online). Use this as the "observe" step of a monitor→decide→steer/cancel loop.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to inspect (must be live).' },
      stalledMsThreshold: { type: 'number', description: 'Mark the session STALLED when time since the last event exceeds this many ms (default 60000).' },
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
}

function renderArchived(ids: readonly string[]): string {
  if (ids.length === 0) return '(no archived sessions)'
  return 'archived: ' + ids.join(', ')
}

function registerArchive(env: BridgeEnv): void {
  env.ctx.tools.register(defineTool({
    name: 'session_bridge_archive',
    description: 'Archive one session: add it to the workspace registry\'s global archive set so it is hidden from every grouping surface in the UI (Un/grouped, workspaces) while its session history and workspace position are preserved. Mirrors the workspace controller archiveSession. The session must exist (live or in session persistence). Returns the complete resulting archive set.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to archive.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return [{ type: 'text' as const, text: 'archived ' + String(v.sessionId) + '\n' + renderArchived((v.archivedSessionIds as string[] | undefined) ?? []) }]
      },
    },
    async execute(args: ArchiveArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      const sessionId = args.sessionId.trim()
      try {
        await env.ctx.workspaceRegistry.archiveSession(sessionId as SessionId)
      } catch (error) {
        throw new Error('cannot archive session ' + JSON.stringify(sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
      }
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      return asJson({ sessionId, archivedSessionIds: archived, totalArchived: archived.length })
    },
  }))

  env.ctx.tools.register(defineTool({
    name: 'session_bridge_archived',
    description: 'List the session ids currently in the workspace registry archive set (hidden from groupings). Optionally resolve titles from the session log. Read-only.',
    parameters: {
      resolveTitles: { type: 'boolean', description: 'When true, resolve each archived session\'s title from its log (default false).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const items = (v.items as Array<{ sessionId: string; title?: string }> | null) ?? []
        if (items.length === 0) return [{ type: 'text' as const, text: '(no archived sessions)' }]
        return [{ type: 'text' as const, text: items.map((i) => i.sessionId + (i.title === undefined ? '' : ' ("' + i.title + '")')).join('\n') }]
      },
    },
    async execute(args: { resolveTitles?: boolean }) {
      const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String)
      const items: Array<{ sessionId: string; title?: string }> = archived.map((id) => ({ sessionId: id }))
      if (args.resolveTitles === true && items.length > 0) {
        const persistence = env.ctx.sessionPersistence as unknown as { inspect(id: string): Promise<{ events: readonly SessionEvent[] }> }
        const registryTitles = new Map<string, string>()
        try {
          const records = await env.registry.all()
          for (const rec of records) if (rec.title !== undefined) registryTitles.set(rec.sessionId, rec.title)
        } catch { /* best-effort */ }
        for (const item of items) {
          if (registryTitles.has(item.sessionId)) {
            item.title = registryTitles.get(item.sessionId)
            continue
          }
          try {
            const inspection = await persistence.inspect(item.sessionId)
            item.title = titleOf(inspection.events)
          } catch { /* offline title unavailable */ }
        }
      }
      return asJson({ items, total: items.length })
    },
  }))
}

