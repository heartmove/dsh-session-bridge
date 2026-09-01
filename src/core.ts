/**
 * dsh-session-bridge core: 会话创建 / 发消息 / 等待回复 / 读取 / 查找。
 * 所有逻辑跑在插件宿主上下文（rootCtx），操作的是 DSH 真实的会话与 agent 注册表。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'

/** Live 会话 agent 的运行时形态（dsh-agent 公开类型较薄，用结构类型）。 */
export interface LiveAgentLike {
  readonly id: string
  readonly status: 'running' | 'idle'
  readonly session: Session
  readonly options?: { provider?: string; model?: string; reasoningEffort?: string }
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(cause?: unknown, options?: { keepInbox?: boolean }): void
  whenIdle?(): Promise<void>
  readonly ctx: Context
  readonly inbox?: {
    hasPending: boolean
    nextTurn?: readonly unknown[]
    nextStep?: readonly unknown[]
  }
}

export interface BridgeMessageRow {
  seq: number
  time: number
  role: 'user' | 'assistant'
  text?: string
  reasoning?: string
  images: number
  toolCalls?: string[]
}

export interface BridgeWaitResult {
  message: BridgeMessageRow | null
  seq: number
  turnEnded: boolean
  timedOut: boolean
  aborted: boolean
  waitedMs: number
}

export interface BridgeFindItem {
  sessionId: string
  title?: string
  cwd?: string
  workspaceId?: string
  live: boolean
  running?: boolean
  parentSession?: string
  origin?: 'subagent'
  createdAt?: number
  updatedAt?: number
  agentPreset?: string
}

/** agent.followup / steer 接受的用户消息值。 */
export function userMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function blockText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown } | null
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const raw of content) {
    const block = raw as { type?: unknown } | null
    if (block !== null && typeof block === 'object' && block.type === 'image') n += 1
  }
  return n
}

function toolNamesOf(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return []
  const names: string[] = []
  for (const raw of toolCalls) {
    const call = raw as { name?: unknown } | null
    if (call !== null && typeof call === 'object' && typeof call.name === 'string' && !names.includes(call.name)) names.push(call.name)
  }
  return names
}

/** 折叠会话事件日志为可读消息行（跳过非 user 来源与空消息）。 */
export function foldMessages(events: readonly SessionEvent[]): BridgeMessageRow[] {
  const rows: BridgeMessageRow[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = (event.data as { source?: { kind?: string } }).source
      if (source !== undefined && source.kind !== 'user') continue
      const text = blockText(event.data.content)
      if (text === undefined) continue
      rows.push({ seq: event.seq, time: event.time, role: 'user', text, images: countImages(event.data.content) })
    } else if (event.type === 'assistant/message') {
      const message = event.data.message as { content?: unknown; reasoning?: unknown; toolCalls?: unknown } | null
      const text = message === null ? undefined : blockText(message.content)
      const reasoning = message === null ? undefined : blockText(message.reasoning)
      const images = message === null ? 0 : countImages(message.content)
      const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls)
      if (text === undefined && reasoning === undefined && toolCalls.length === 0) continue
      const row: BridgeMessageRow = { seq: event.seq, time: event.time, role: 'assistant', images }
      if (text !== undefined) row.text = text
      if (reasoning !== undefined) row.reasoning = reasoning
      if (toolCalls.length > 0) row.toolCalls = toolCalls
      rows.push(row)
    }
  }
  return rows
}

/**
 * 会话标题：优先 session/title 事件（last-wins，与 UI 一致）；
 * 无标题事件时回落为第一条用户消息（截断 80 字符）。
 */
export function titleOf(events: readonly SessionEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    const raw = event as unknown as { type: string; data: { title?: unknown } }
    if (raw.type === 'session/title') {
      const t = raw.data.title
      if (typeof t === 'string' && t !== '') title = t
    }
  }
  if (title !== undefined) return title
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = (event.data as { source?: { kind?: string } }).source
      if (source !== undefined && source.kind !== 'user') continue
      const text = blockText(event.data.content)
      if (text !== undefined) {
        const trimmed = text.replace(/\s+/g, ' ').trim()
        return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed
      }
    }
  }
  return undefined
}

/** 日志最大事件序号。 */
export function maxSeq(events: readonly SessionEvent[]): number {
  let m = -1
  for (const event of events) if (event.seq > m) m = event.seq
  return m
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WaitForReplyOptions {
  session: Session
  baselineSeq: number
  timeoutMs: number
  signal?: AbortSignal
  requireTurnEnd?: boolean
}

/**
 * 轮询等待某会话在 baseline 之后出现新的 assistant 回复。
 *
 * 完成条件默认是"出现一条带文本的新 assistant 回复"（即回复可读），而不是
 * 等待 turn/end。实测发现 bridge 通过 agent.followup() 驱动的 turn 在事件流里
 * 不保证产生 turn/end（会一直等满超时），导致"回复早就有了、读取却要等十几二十秒"。
 * 因此默认不再用 turn/end 作门控；需要完整收尾语义时用 requireTurnEnd:true 显式开启，
 * 此时才会等到其后出现 turn/end。
 *
 * 返回时 message 为"最新的带文本 assistant 行"，否则为最新 assistant 行（可能无文本，
 * 如纯工具调用中间态）；超时/中止返回已收集内容。
 */
export async function waitForReply(opts: WaitForReplyOptions): Promise<BridgeWaitResult> {
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  const requireTurnEnd = opts.requireTurnEnd ?? false
  let latest: BridgeMessageRow | null = null
  let textReply: BridgeMessageRow | null = null
  let turnEnded = false
  for (;;) {
    if (opts.signal !== undefined && opts.signal.aborted) break
    const events = opts.session.events
    for (const row of foldMessages(events)) {
      if (row.seq <= opts.baselineSeq || row.role !== 'assistant') continue
      if (latest === null || row.seq > latest.seq) latest = row
      if (row.text !== undefined && (textReply === null || row.seq > textReply.seq)) textReply = row
    }
    if (requireTurnEnd && latest !== null) {
      for (const event of events) {
        if (event.seq > latest.seq && event.type === 'turn/end') { turnEnded = true; break }
      }
    }
    const done = requireTurnEnd ? (latest !== null && turnEnded) : textReply !== null
    if (done) break
    if (Date.now() >= deadline) break
    await sleep(100)
  }
  const message = textReply ?? latest
  return {
    message,
    seq: message === null ? opts.baselineSeq : message.seq,
    turnEnded,
    timedOut: requireTurnEnd ? (latest !== null && !turnEnded) : textReply === null,
    aborted: opts.signal !== undefined && opts.signal.aborted,
    waitedMs: Date.now() - started,
  }
}

export interface TargetCwdArgs {
  workspaceId?: string
  cwd?: string
}

/**
 * 解析目标工作目录：workspaceId（注册表）> cwd（绝对路径/任意拼写）> 调用者会话 cwd。
 * 跨工作区由 workspaceId / cwd 任意指定实现。
 */
export async function resolveTargetCwd(ctx: Context, callerCwd: string | undefined, args: TargetCwdArgs): Promise<string> {
  if (typeof args.workspaceId === 'string' && args.workspaceId !== '') {
    const ws = ctx.workspaceRegistry.get(WorkspaceId(args.workspaceId))
    if (ws === undefined) throw new Error(`workspace not found: ${args.workspaceId}`)
    return ws.path
  }
  if (typeof args.cwd === 'string' && args.cwd.trim() !== '') return args.cwd.trim()
  if (callerCwd !== undefined && callerCwd !== '') return callerCwd
  throw new Error('cannot determine target working directory: pass cwd or workspaceId')
}

/** 会话 id → workspace id（遍历注册表反查，跨全部工作区）。 */
export function workspaceBySession(ctx: Context): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const ws of ctx.workspaceRegistry.list()) {
    for (const sessionId of ws.sessionIds) map.set(sessionId, String(ws.id))
  }
  return map
}

/** 会话 cwd → workspace id（按路径匹配；无则 undefined）。 */
export function workspaceByPath(ctx: Context, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  for (const ws of ctx.workspaceRegistry.list()) {
    if (ws.path === cwd) return ws.id
  }
  return undefined
}

/**
 * 将会话计入其 cwd 所属的 workspace（镜像 session-controller 的 create /
 * fork 记账：它们创建代理后都会调用 workspace.attachSession）。没有这一步，
 * bridge 直建的新会话不会出现在任何 workspace 组，而是落到 UI 的"未分组"。
 * cwd 无可校验 workspace 时（目录未登记/无法解析）返回 undefined，会话保持
 * 未分组，与 workspace 的既有语义一致；attach 失败只告警、不阻断会话本身。
 * @returns 会话所属 workspace id，无可归属时 undefined。
 */
export async function attachSessionToWorkspace(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd === '') return undefined
  let workspace: Workspace | undefined
  try {
    workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
  } catch {
    workspace = undefined
  }
  if (workspace === undefined) return undefined
  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    console.warn(
      `[dsh-session-bridge] failed to attach session '${sessionId}' to workspace '${workspace.id}': `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
  return workspace.id
}

/** 一次会话监控快照：供"监控线程"判断主任务是否在跑、有无进展、是否卡住。 */
export interface BridgeStatusSnapshot {
  sessionId: string
  live: boolean
  running: 'running' | 'idle'
  title?: string
  cwd?: string
  workspaceId?: string
  /** 是否有未闭合的 turn（agent 正在处理一轮）。 */
  openTurn: boolean
  /** 最新 turn 编号（0 = 尚未开始第一轮）。 */
  lastTurn: number
  /** 最近一次事件时间戳（无事件为 null）；用于卡住检测。 */
  lastActivityAt: number | null
  /** 距最近一次事件已过去多少毫秒（now - lastActivityAt）。 */
  stalledMs: number | null
  /** 是否有待处理输入（inbox 排队中的消息）。 */
  pendingWork: boolean
  nextTurnCount: number
  nextStepCount: number
  /** 最新一条带文本的 assistant 回复。 */
  lastAssistantText?: string
  /** 折叠后的消息总数。 */
  messageCount: number
  /** 最近几条消息（默认 8）。 */
  recent: BridgeMessageRow[]
}

/**
 * 计算一个 live 会话的监控快照（agent 状态 + 事件折叠出的进度/卡住事实）。
 * 纯读，无副作用。用于 `session_bridge_status`。
 */
export function statusSnapshot(ctx: Context, agent: LiveAgentLike): BridgeStatusSnapshot {
  const events = agent.session.events
  const rows = foldMessages(events)
  let lastActivityAt: number | null = null
  let lastTurn = 0
  let openTurn = false
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const turn = (event.data as { turn?: number } | null)?.turn
      if (typeof turn === 'number' && turn > 0) lastTurn = turn
    }
    if (event.type === 'turn/start') openTurn = true
    if (event.type === 'turn/end') openTurn = false
    if (event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time
  }
  const recent = rows.slice(-8)
  let lastAssistantText: string | undefined
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row !== undefined && row.role === 'assistant' && row.text !== undefined) {
      lastAssistantText = row.text
      break
    }
  }
  const inbox = agent.inbox
  const cwd = agent.session.header.cwd
  return {
    sessionId: agent.id,
    live: true,
    running: agent.status,
    title: titleOf(events),
    ...(cwd === undefined ? {} : { cwd }),
    ...(workspaceByPath(ctx, cwd) === undefined ? {} : { workspaceId: workspaceByPath(ctx, cwd) }),
    openTurn,
    lastTurn,
    lastActivityAt,
    stalledMs: lastActivityAt === null ? null : Date.now() - lastActivityAt,
    pendingWork: inbox?.hasPending ?? false,
    nextTurnCount: inbox?.nextTurn?.length ?? 0,
    nextStepCount: inbox?.nextStep?.length ?? 0,
    ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
    messageCount: rows.length,
    recent,
  }
}

/** 取 live agent（跨工具/监控共用）。不存在返回 undefined。 */
export function getLiveAgent(ctx: Context, sessionId: string): LiveAgentLike | undefined {
  const agents = ctx.agents as unknown as { get(id: string): LiveAgentLike | undefined }
  return agents.get(sessionId)
}

/** 对 live 会话发送一条用户消息（queue=追加一轮，steer=打断当前步注入）。 */
export function sendLiveMessage(ctx: Context, sessionId: string, message: string, mode: 'queue' | 'steer'): boolean {
  const agent = getLiveAgent(ctx, sessionId)
  if (agent === undefined) return false
  if (mode === 'steer') agent.steer(userMessage(message))
  else agent.followup(userMessage(message))
  return true
}

/** 中止一个 live 会话的活动 turn（可保留队列输入）。返回是否发起了取消。 */
export function cancelLiveSession(ctx: Context, sessionId: string, keepInbox: boolean, reason: string | undefined): boolean {
  const agent = getLiveAgent(ctx, sessionId)
  if (agent === undefined) return false
  const cause = typeof reason === 'string' && reason.trim() !== ''
    ? { kind: 'hook', reason: reason.trim() }
    : { kind: 'user' }
  agent.cancel(cause, { keepInbox })
  return true
}
