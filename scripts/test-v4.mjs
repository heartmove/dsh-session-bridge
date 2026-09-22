import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { migratedSession } from './v4-fixture.mjs'
import { foldMessages, inspectPersistedSession, maxSeq, sessionEvents, statusSnapshot } from '../src/core.ts'

test('V3 missing turn/end migrates to V4 and bridge uses remapped sequences', () => {
  const artifact = migratedSession()
  assert.equal(artifact.header.version, 4)
  assert.equal(artifact.events[3].type, 'turn/end')
  assert.equal(artifact.events[3].data.reason.kind, 'interrupted')
  const session = Session.create(artifact.header.id, artifact.events, artifact.header, 0)
  const events = sessionEvents(session)
  assert.equal(maxSeq(artifact.events), 6)
  // Restoring a live Session appends its lifecycle seed marker after the log.
  assert.equal(maxSeq(events), 7)
  assert.equal(foldMessages(events).at(-1).seq, 5)
  const status = statusSnapshot({}, { id: session.id, session, status: 'idle' })
  assert.equal(status.openTurn, false)
  assert.equal(status.lastTurn, 2)
})

test('offline read consumes the persistence-owned V4 result and closes its read lease', async () => {
  const artifact = migratedSession()
  let closed = false
  const ctx = { sessionPersistence: { async open(id, access) {
    assert.equal(id, 'compat')
    assert.equal(access, 'read')
    return { header: artifact.header, read: async () => artifact, close: async () => { closed = true } }
  } } }
  const result = await inspectPersistedSession(ctx, 'compat')
  assert.equal(closed, true)
  assert.deepEqual(result.events, artifact.events)
})

test('offline read closes the lease and surfaces migration/read failures', async () => {
  let closed = false
  const failure = new Error('unsupported historical event')
  const ctx = { sessionPersistence: { open: async () => ({
    header: {}, read: async () => { throw failure }, close: async () => { closed = true },
  }) } }
  await assert.rejects(inspectPersistedSession(ctx, 'compat'), failure)
  assert.equal(closed, true)
})
