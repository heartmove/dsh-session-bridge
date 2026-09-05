/**
 * dsh-session-bridge monitor: 线程内的后台守护循环。
 * 对一个"主任务会话"按配置间隔轮询其进度（复用 statusSnapshot/规则判定），
 * 根据实际情况自动调度——卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、
 * 出现完成关键词且空闲则结束监控并留档。可选 LLM 增强：判定是否偏离主题。
 * 作为插件自身的组件存在（非独立插件），用 session_bridge_monitor_start/_stop/_list 控制。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  cancelLiveSession,
  getLiveAgent,
  sendLiveMessage,
  statusSnapshot,
  type BridgeStatusSnapshot,
} from './core.ts'

export interface MonitorConfig {
  /** 目标主任务会话 id。 */
  sessionId: string
  /** 轮询间隔（毫秒），默认 10000。 */
  intervalMs: number
  /** 距最近一次事件超过该毫秒数即视为"卡住"，默认 60000。 */
  stalledMs?: number
  /** 连续卡住超过多少次后自动 cancel 终止，默认 3。 */
  maxStuckCycles?: number
  /** 判定为完成后出现的文本关键词（任一命中即视为完成信号）。 */
  doneKeywords: string[]
  /** 卡住时注入的 steer 文本（催办/纠偏），默认催办。 */
  onStallSteer?: string
  /** 是否用 LLM 判断偏离主题（默认 false，用规则即可）。 */
  useLlm?: boolean
  /** LLM 判定偏离时的纠正 steer 文本。 */
  onOffTrackSteer?: string
  /** 监控日志文件路径（缺省 DSH_HOME/super-injector/dsh-session-bridge-monitor.log）。 */
  logFile?: string
  /** 监控会话的说明，仅用于展示。 */
  label?: string
  /** 思维链（CoT）规则：对实时推理/文本做 contains/not-contains 匹配，持续命中达 cotMinHits 后触发 steer 或 cancel。 */
  coTRules?: CoTRule[]
  /** 一条规则连续命中多少个 tick 才触发（默认 1 = 立即）。 */
  cotMinHits?: number
}

/** 一条思维链规则：匹配实时链的内容并触发动作。 */
export interface CoTRule {
  /** contains = 匹配内容必须包含 value；not-contains = 必须不含 value。 */
  match: 'contains' | 'not-contains'
  /** 在哪个字段上匹配：reasoning（思维链）/ text（回复文本）/ both（任一）。 */
  field: 'reasoning' | 'text' | 'both'
  /** 匹配的关键词（非空）。 */
  value: string
  /** 触发动作：cancel 立即终止会话；steer 注入一条用户消息引导。 */
  action: 'steer' | 'cancel'
  /** steer 时的注入文案（缺省用默认催办文案）。 */
  message?: string
}

/** 一条 CoT 规则的连续命中计数（防单次 tick 误触发 & 防重复触发）。 */
export interface CoTRuleState {
  hits: number
  lastFiredAt: number | null
  lastMatch: boolean
  lastSubject: string
}

export interface MonitorEntryState {
  config: MonitorConfig
  startedAt: number
  lastTickAt: number
  stuckCount: number
  lastAction: 'none' | 'steer' | 'cancel' | 'done' | 'lost' | 'offtrack' | 'steady' | 'cot-steer' | 'cot-cancel'
  lastActionAt: number | null
  lastNote: string
  done: boolean
  cycles: number
  cot: {
    rules: { [key: string]: CoTRuleState }
  }
}

const SCAN_MS = 5000

function dshLogFile(override: string | undefined): string {
  if (override !== undefined && override !== '') return override
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'dsh-session-bridge-monitor.log')
}

export class SessionMonitor {
  private readonly entries = new Map<string, MonitorEntryState>()
  private timer: unknown | undefined
  private readonly logFile: string

  constructor(
    private readonly ctx: Context,
    logFile?: string,
  ) {
    this.logFile = dshLogFile(logFile)
  }

  /** 启动对一个会话的监控（幂等：已存在则更新配置）。 */
  start(config: MonitorConfig): MonitorEntryState {
    const existing = this.entries.get(config.sessionId)
    const now = Date.now()
    const cotInit: MonitorEntryState['cot'] = {
      rules: (config.coTRules ?? []).reduce<Record<string, CoTRuleState>>((acc, rule, index) => {
        const key = String(index) + ':' + rule.match + ':' + rule.field + ':' + rule.value
        acc[key] = { hits: 0, lastFiredAt: null, lastMatch: false, lastSubject: '' }
        return acc
      }, {}),
    }
    const entry: MonitorEntryState = existing !== undefined
      ? { ...existing, config, lastTickAt: now }
      : {
        config,
        startedAt: now,
        lastTickAt: now,
        stuckCount: 0,
        lastAction: 'none',
        lastActionAt: null,
        lastNote: '监控已启动',
        done: false,
        cycles: 0,
        cot: cotInit,
      }
    if (entry.cot === undefined) entry.cot = cotInit
    this.entries.set(config.sessionId, entry)
    this.ensureTimer()
    this.log(entry, 'monitor start session=' + config.sessionId + ' interval=' + config.intervalMs
      + ' stalled=' + String(config.stalledMs ?? 60000) + ' maxStuck=' + String(config.maxStuckCycles ?? 3))
    return entry
  }

  /** 停止对一个会话的监控。返回是否存在。 */
  stop(sessionId: string): boolean {
    const existed = this.entries.delete(sessionId)
    if (this.entries.size === 0) this.disposeTimer()
    if (existed) this.stderr('[dsh-session-bridge] monitor stop session=' + sessionId)
    return existed
  }

  /** 全部活动监控快照。 */
  list(): MonitorEntryState[] {
    return [...this.entries.values()].map((e) => ({ ...e, config: { ...e.config } }))
  }

  /** 移除所有监控（插件卸载用）。 */
  dispose(): void {
    this.disposeTimer()
    this.entries.clear()
  }

  /** 立即触发一轮扫描（测试/手动）。 */
  async tickNow(): Promise<void> {
    await this.tick()
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return
    const timer = this.ctx as unknown as { setInterval(fn: () => void, ms: number): unknown }
    this.timer = timer.setInterval(() => {
      void this.tick().catch((error) => {
        this.stderr('[dsh-session-bridge] monitor tick error: ' + String(error))
      })
    }, SCAN_MS)
  }

  private disposeTimer(): void {
    if (this.timer === undefined) return
    const ctx = this.ctx as unknown as { clearInterval(handle: unknown): void }
    try { ctx.clearInterval(this.timer) } catch { /* noop */ }
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (entry.done) continue
      if (now - entry.lastTickAt < entry.config.intervalMs) continue
      entry.lastTickAt = now
      entry.cycles += 1
      await this.tickEntry(entry)
    }
  }

  private async tickEntry(entry: MonitorEntryState): Promise<void> {
    const { sessionId } = entry.config
    const agent = getLiveAgent(this.ctx, sessionId)
    if (agent === undefined) {
      entry.stuckCount += 1
      entry.lastAction = 'lost'
      entry.lastActionAt = Date.now()
      entry.lastNote = '目标会话离线（不在 live）'
      this.log(entry, 'target not live; stuck=' + entry.stuckCount)
      if (this.shouldCancel(entry)) this.doCancel(entry, '目标会话离线')
      return
    }
    const snapshot = statusSnapshot(this.ctx, agent)

    // 1) 完成判定：出现完成关键词（且空闲）。
    if (this.isDone(entry, snapshot)) {
      entry.done = true
      entry.lastAction = 'done'
      entry.lastActionAt = Date.now()
      entry.lastNote = '检测到完成信号，监控结束'
      this.log(entry, 'DONE → stop monitor')
      this.stopWithLog(sessionId)
      return
    }

    // 1b) 空闲且无待处理：任务已静默结束，收尾而不是反复催办/取消。
    if (snapshot.running !== 'running' && !snapshot.pendingWork) {
      entry.done = true
      entry.lastAction = 'done'
      entry.lastActionAt = Date.now()
      entry.lastNote = '目标已空闲且无待处理，监控收尾'
      this.log(entry, 'IDLE no-pending → stop monitor (settled)')
      this.stopWithLog(sessionId)
      return
    }

    // 2) 卡住判定：仅对 running 会话有意义（距最近事件超过阈值）。
    const stalled = snapshot.running === 'running'
      && snapshot.stalledMs !== null
      && snapshot.stalledMs > (entry.config.stalledMs ?? 60000)
    if (stalled) {
      entry.stuckCount += 1
      entry.lastActionAt = Date.now()
      if (this.shouldCancel(entry)) {
        this.doCancel(entry, '卡住超过 ' + entry.config.maxStuckCycles + ' 次')
        return
      }
      // 3) 可选 LLM 偏离判定（有 llm 且开启时）。
      if (entry.config.useLlm === true && this.hasLlm()) {
        const offtrack = await this.judgeOffTrack(entry, snapshot, agent.options as { provider?: string; model?: string })
        if (offtrack === 'offtrack') {
          const steer = entry.config.onOffTrackSteer ?? '检测到任务偏离主题，请回到原始目标继续，并简要说明你下一步怎么做。'
          sendLiveMessage(this.ctx, sessionId, steer, 'steer')
          entry.lastAction = 'offtrack'
          entry.lastNote = 'LLM 判定偏离主题，已 steer 纠偏'
          entry.stuckCount = 0
          this.log(entry, 'OFFTRACK → steer: ' + steer)
          return
        }
        if (offtrack === 'stuck') {
          const steer = entry.config.onStallSteer ?? '较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。'
          sendLiveMessage(this.ctx, sessionId, steer, 'steer')
          entry.lastAction = 'steer'
          entry.lastNote = 'LLM 判定卡住，已 steer 催办'
          this.log(entry, 'STUCK → steer: ' + steer)
          return
        }
        // 'steady'：LLM 认为仍在推进，重置。
        entry.lastAction = 'steady'
        entry.lastNote = 'LLM 判定仍在推进'
        entry.stuckCount = 0
        this.log(entry, 'LLM verdict=steady; reset stuck')
        return
      }
      // 4) 纯规则：卡住 → steer 催办。
      const steer = entry.config.onStallSteer ?? '较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。'
      sendLiveMessage(this.ctx, sessionId, steer, 'steer')
      entry.lastAction = 'steer'
      entry.lastNote = '卡住 ' + entry.stuckCount + ' 次，已 steer 催办'
      this.log(entry, 'STALL(#' + entry.stuckCount + ') → steer: ' + steer)
      return
    }

    // 4b) 思维链（CoT）规则检查：对实时推理/文本做匹配，持续命中则 steer/cancel。
    // 与卡住逻辑正交：即使会话在推进，只要思维链不符合规则也可提前终止/纠偏。
    const cotHandled = this.evaluateCoTRules(entry, snapshot, sessionId)
    if (cotHandled) return

    // 5) 正常推进：重置卡住计数。
    if (entry.stuckCount !== 0) entry.stuckCount = 0
    entry.lastAction = 'steady'
    entry.lastActionAt = Date.now()
    entry.lastNote = '正常推进（lastActivity now-' + String(snapshot.stalledMs ?? '?') + 'ms）'
    this.log(entry, 'steady; lastActivity now-' + String(snapshot.stalledMs ?? '?') + 'ms')
  }

  private shouldCancel(entry: MonitorEntryState): boolean {
    return entry.stuckCount >= (entry.config.maxStuckCycles ?? 3)
  }

  private doCancel(entry: MonitorEntryState, reason: string): void {
    cancelLiveSession(this.ctx, entry.config.sessionId, false, reason)
    entry.lastAction = 'cancel'
    entry.lastActionAt = Date.now()
    entry.lastNote = '连续卡住，已 cancel 终止: ' + reason
    this.log(entry, 'CANCEL session=' + entry.config.sessionId + ' reason=' + reason)
  }

  private isDone(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot): boolean {
    const keywords = entry.config.doneKeywords ?? []
    if (keywords.length === 0) return false
    // 只有空闲才算真正收尾（避免 turn 中途误判完成）。
    if (snapshot.running === 'running') return false
    const text = `${snapshot.lastAssistantText ?? ''}\n${snapshot.recent.map((r) => r.text ?? '').join('\n')}`
    if (!text) return false
    return keywords.some((kw) => kw !== '' && text.includes(kw))
  }

  /**
   * 评估思维链（CoT）规则。规则只对 live 会话有意义：running 时用进行中的
   * reasoning-delta 流，空闲时回落到已定型 lastReasoning。not-contains 规则作用在
   * reasoning 字段时，若该会话本就没有推理（非推理模型/尚未产出），不判定为命中，
   * 避免误 cancel 一个根本不产生思维链的会话。
   * @returns true 表示本 tick 已被某条规则触发并处理（steer/cancel），调用方应 return。
   */
  private evaluateCoTRules(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot, sessionId: string): boolean {
    const rules = entry.config.coTRules ?? []
    if (rules.length === 0) return false
    const minHits = entry.config.cotMinHits ?? 1

    // 评估主体：进行中的实时推理/文本，否则已定型的上次推理/回复。
    const hasLive = (snapshot.liveReasoning ?? '') !== ''
    const subject = {
      reasoning: snapshot.liveReasoning ?? snapshot.lastReasoning ?? '',
      text: snapshot.lastAssistantText ?? '',
      hasReasoning: hasLive || (snapshot.lastReasoning ?? '') !== '',
    }

    const now = Date.now()
    const rulesState = entry.cot
    let engaged = false
    rules.forEach((rule, index) => {
      if (engaged) return
      const key = String(index) + ':' + rule.match + ':' + rule.field + ':' + rule.value
      const st = rulesState.rules[key] ?? { hits: 0, lastFiredAt: null, lastMatch: false }

      // not-contains 作用在 reasoning 且本就没有推理时：不算命中。
      if (rule.field === 'reasoning' && rule.match === 'not-contains' && !subject.hasReasoning) {
        st.lastMatch = false
        st.hits = 0
        return
      }

      let hit: boolean
      if (rule.field === 'reasoning') {
        hit = rule.match === 'contains' ? subject.reasoning.includes(rule.value) : !subject.reasoning.includes(rule.value)
      } else if (rule.field === 'text') {
        hit = rule.match === 'contains' ? subject.text.includes(rule.value) : !subject.text.includes(rule.value)
      } else { // 'both'
        const reasonHas = subject.reasoning.includes(rule.value)
        const textHas = subject.text.includes(rule.value)
        hit = rule.match === 'contains' ? (reasonHas || textHas) : (!reasonHas && !textHas)
      }

      st.lastMatch = hit
      st.hits = hit ? st.hits + 1 : 0
      this.log(entry, 'CoT rule ' + key + ' hit=' + String(hit) + ' hits=' + String(st.hits) + '/' + String(minHits))

      const shouldFire = hit && st.hits >= minHits
      if (!shouldFire) return
      // 冷却：同一规则在冷却窗口内不重复触发（除非匹配状态先复位再命中）。
      const coolMs = Math.max(entry.config.intervalMs, 5000) * 2
      if (st.lastFiredAt !== null && now - st.lastFiredAt < coolMs) return

      st.lastFiredAt = now
      if (rule.action === 'cancel') {
        const reason = 'reasoning-rule:' + rule.value
        cancelLiveSession(this.ctx, sessionId, false, reason)
        entry.lastAction = 'cot-cancel'
        entry.lastActionAt = Date.now()
        entry.lastNote = '思维链规则触发 cancel: ' + rule.value
        entry.stuckCount = 0
        this.log(entry, 'COT-CANCEL session=' + sessionId + ' rule=' + key + ' value=' + rule.value)
      } else {
        const steer = rule.message !== undefined && rule.message.trim() !== ''
          ? rule.message.trim()
          : '监控判定：思维链/回复匹配规则「' + rule.value + '」，请据此调整方向并继续推进任务。'
        sendLiveMessage(this.ctx, sessionId, steer, 'steer')
        entry.lastAction = 'cot-steer'
        entry.lastActionAt = Date.now()
        entry.lastNote = '思维链规则触发 steer: ' + rule.value
        entry.stuckCount = 0
        this.log(entry, 'COT-STEER session=' + sessionId + ' rule=' + key + ' steer=' + steer)
      }
      engaged = true
      st.hits = 0
    })
    return engaged
  }

  private hasLlm(): boolean {
    const ctx = this.ctx as unknown as { llm?: LlmService }
    return ctx.llm !== undefined
  }

  /** LLM 判定当前状态：'stuck' | 'offtrack' | 'steady'。失败回落 'steady'。 */
  private async judgeOffTrack(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot, route: { provider?: string; model?: string }): Promise<'stuck' | 'offtrack' | 'steady'> {
    const ctx = this.ctx as unknown as { llm?: LlmService }
    if (ctx.llm === undefined) return 'steady'
    // 用主任务 agent 自身的模型路由（若无则无法发起 LLM 判定，回落规则）。
    const provider = route.provider
    const model = route.model
    if (provider === undefined || model === undefined) return 'steady'
    const recentText = snapshot.recent.map((r) => (r.role === 'user' ? '[user]' : '[assistant]') + ' ' + (r.text ?? r.reasoning ?? '')).join('\n').slice(-1200)
    try {
      let text = ''
      const stream = ctx.llm.stream({
        provider,
        model,
        system: '你是任务监控 agent。给定一个主任务会话的最新消息流，判定它当前处于哪种状态，只输出一个词：stuck（很久无实质进展）/ offtrack（明显偏离原始目标）/ steady（正常推进）。',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: recentText }] })],
        temperature: 0,
        reasoningEffort: ReasoningEffortId('off'),
        maxTokens: 40,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      const verdict = text.trim().toLowerCase()
      if (verdict.startsWith('stuck')) return 'stuck'
      if (verdict.startsWith('offtrack')) return 'offtrack'
      return 'steady'
    } catch {
      return 'steady'
    }
  }

  private stopWithLog(sessionId: string): void {
    this.stderr('[dsh-session-bridge] monitor session=' + sessionId + ' marked done')
    this.entries.delete(sessionId)
    if (this.entries.size === 0) this.disposeTimer()
  }

  private log(entry: MonitorEntryState, msg: string): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      appendFileSync(this.logFile, `[${new Date().toISOString()}] session=${entry.config.sessionId} lastReply=${entry.config.label ?? ''} ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  private stderr(msg: string): void {
    try {
      console.warn(msg)
    } catch { /* noop */ }
  }
}
