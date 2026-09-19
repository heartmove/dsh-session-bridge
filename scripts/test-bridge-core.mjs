#!/usr/bin/env node
/**
 * Regression tests for the session-bridge core wait/stall logic (GitHub issue #1):
 *
 *   Bug 1 — session_bridge_wait 返回 "(no text)" 并跑满超时，即使回复早已存在。
 *   Bug 2 — session_bridge_status 把空闲会话标成 [STALLED]。
 *
 * Runs against src/core.ts directly (Node type stripping — no build, no deps, no
 * host/Dsh runtime needed): `npm test`. The fake Session only has to expose the
 * read path core.sessionEvents() probes (`snapshotEvents()`).
 */
import assert from 'node:assert/strict'
import { foldMessages, isStalled, maxSeq, waitForReply } from '../src/core.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + (error instanceof Error ? error.message : String(error)))
  }
}

// --- synthetic event log -----------------------------------------------------
const turnStart = (seq, turn = 1) => ({ seq, time: seq, type: 'turn/start', data: { turn } })
const turnEnd = (seq, turn = 1) => ({ seq, time: seq, type: 'turn/end', data: { turn } })
const userMsg = (seq, text) => ({ seq, time: seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistantText = (seq, text, step = 1) => ({ seq, time: seq, type: 'assistant/message', data: { turn: 1, step, message: { content: [{ type: 'text', text }] } } })
/** 纯工具调用中间行：无文本（foldMessages 会给出一个没有 text 的 assistant 行）。 */
const assistantTool = (seq, name = 'bash', step = 2) => ({ seq, time: seq, type: 'assistant/message', data: { turn: 1, step, message: { content: [{ type: 'text', text: '' }], toolCalls: [{ name }] } } })
/** 带 reasoning 的已完成段落。 */
const assistantReasoning = (seq, reasoning, text) => ({ seq, time: seq, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] } } })
/** 假 Session：core.sessionEvents() 会走 snapshotEvents() 分支。 */
const fakeSession = (events) => ({ snapshotEvents: () => events })

// --- Bug 2: stall semantics ---------------------------------------------------
await test('isStalled: idle sessions are never stalled (issue #1 Bug 2)', () => {
  assert.equal(isStalled('idle', 10_000_000, 60_000), false)
  assert.equal(isStalled('idle', 0, 60_000), false)
})

await test('isStalled: running sessions stall only past the threshold', () => {
  assert.equal(isStalled('running', 10_000_000, 60_000), true)
  assert.equal(isStalled('running', 60_000, 60_000), false) // "exceeds" is strict
  assert.equal(isStalled('running', 60_001, 60_000), true)
  assert.equal(isStalled('running', null, 60_000), false)
})

// --- Bug 1: wait never loses an already-landed reply --------------------------
await test('wait reply-mode: pre-existing reply at baseline -> stale + text (main symptom)', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'pong'), turnEnd(3)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: 2, timeoutMs: 1 })
  assert.equal(result.message?.text, 'pong')
  assert.equal(result.message?.seq, 2)
  assert.equal(result.stale, true)
  assert.equal(result.timedOut, true)
  assert.equal(result.seq, 2)
})

await test('wait reply-mode: never returns a later text-less step as the reply', async () => {
  // 回复已落地，目标会话随后又跑了工具调用/推理步（更晚但无文本）。
  // 旧实现 message = textReply ?? latest 会把这个无文本行交出去 -> 渲染 "(no text)"。
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'pong'), assistantTool(3), turnEnd(4)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: maxSeq(events), timeoutMs: 1 })
  assert.equal(result.message?.text, 'pong')
  assert.equal(result.message?.seq, 2)
  assert.equal(result.stale, true)
  assert.equal(result.timedOut, true)
})

await test('wait reply-mode: legacy baseline (last text row) with a newer tool row', async () => {
  // 旧默认 baseline = 最后一条带文本行；更晚的无文本行让它返回无文本行。
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'pong'), assistantTool(3)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: 2, timeoutMs: 1 })
  assert.equal(result.message?.text, 'pong')
  assert.equal(result.stale, true)
  assert.equal(result.timedOut, true)
})

await test('wait reply-mode: a genuinely new reply returns immediately, stale=false', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'old')]
  const baseline = maxSeq(events)
  setTimeout(() => { events.push(assistantText(3, 'new')) }, 30)
  const started = Date.now()
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: baseline, timeoutMs: 2_000 })
  assert.equal(result.message?.text, 'new')
  assert.equal(result.stale, false)
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - started < 1_000, 'should return as soon as the new reply lands')
})

await test('wait segment-mode: pre-existing segment -> stale + segment fields', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantReasoning(2, 'thinking…', 'answer'), turnEnd(3)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: maxSeq(events), timeoutMs: 1, waitForSegment: true })
  assert.equal(result.stale, true)
  assert.equal(result.seq, 2)
  assert.equal(result.message?.text, 'answer')
  assert.equal(result.message?.reasoning, 'thinking…')
})

await test('wait reply-mode: no assistant text at all -> message null, stale=false', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantTool(2)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: maxSeq(events), timeoutMs: 1 })
  assert.equal(result.message, null)
  assert.equal(result.stale, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.seq, maxSeq(events))
})

await test('wait requireTurnEnd: new row without turn/end -> timedOut, stale fallback text', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'first'), assistantTool(3)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: 2, timeoutMs: 1, requireTurnEnd: true })
  assert.equal(result.timedOut, true)
  assert.equal(result.turnEnded, false)
  assert.equal(result.stale, true)
  assert.equal(result.message?.text, 'first')
})

await test('wait requireTurnEnd: nothing new at all -> timedOut (was misreported as false)', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'first'), assistantTool(3), turnEnd(4)]
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: maxSeq(events), timeoutMs: 1, requireTurnEnd: true })
  assert.equal(result.timedOut, true)
  assert.equal(result.stale, true)
  assert.equal(result.message?.text, 'first')
})

await test('wait sinceSeq=-1 anchor (create path): existing reply counts as new', async () => {
  const events = [turnStart(0), userMsg(1, 'hi'), assistantText(2, 'hello')]
  const started = Date.now()
  const result = await waitForReply({ session: fakeSession(events), baselineSeq: -1, timeoutMs: 2_000 })
  assert.equal(result.message?.text, 'hello')
  assert.equal(result.stale, false)
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - started < 1_000, 'should return without waiting (nothing to wait for)')
})

// --- sanity -------------------------------------------------------------------
await test('maxSeq: empty log is -1 (anchor sentinel)', () => {
  assert.equal(maxSeq([]), -1)
  assert.equal(maxSeq(undefined), -1)
  assert.equal(maxSeq([turnStart(0), assistantText(5, 'x')]), 5)
  assert.equal(foldMessages([assistantTool(1)]).length, 1)
  assert.equal(foldMessages([assistantTool(1)])[0].text, undefined)
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)