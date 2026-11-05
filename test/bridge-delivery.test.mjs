import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { appendJsonLine, ensureLayout, FILES, readCursor, readRecords, writeFileAtomic } from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { SESSION_ID, makeBridge, makeWorkspace } from './helpers.mjs'

function codexMessage(text = 'from codex', extra = {}) {
  return makeMessage({ from: 'codex', to: 'dsh', text, hops: 1, ...extra })
}

test('delivers a Codex message and advances the cursor only on acceptance', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge, delivered } = makeBridge(workspace)
  await bridge.start()
  t.after(() => bridge.stop())

  const message = codexMessage('hello dsh')
  await appendJsonLine(workspace.root, FILES.inboxDsh, message)
  const before = await readCursor(workspace.root, FILES.cursorDsh)
  assert.equal(before, 0)

  await bridge.tick('test')

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].id, message.id)
  const after = await readCursor(workspace.root, FILES.cursorDsh)
  assert.ok(after > 0)
  assert.equal(bridge.snapshot().queue.codexToDsh, 0)
})

test('keeps the cursor and backs off when delivery fails', async (t) => {
  const workspace = await makeWorkspace(t)
  let attempts = 0
  const { bridge } = makeBridge(workspace, {
    deliver: async () => {
      attempts += 1
      return { accepted: false, error: { code: 'gateway/internal' } }
    },
  })
  await bridge.start()
  t.after(() => bridge.stop())

  await appendJsonLine(workspace.root, FILES.inboxDsh, codexMessage())
  await bridge.tick('test')

  assert.equal(attempts, 1)
  assert.equal(await readCursor(workspace.root, FILES.cursorDsh), 0)
  assert.equal(bridge.snapshot().lastErrorCode, 'gateway/internal')
  assert.ok(bridge.nextDshAt > bridge.now())
})

test('records resolve-failed and does not deliver to another session', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge, delivered } = makeBridge(workspace, {
    deliver: async () => ({ accepted: false, error: { code: 'session/not-found' } }),
  })
  await bridge.start()
  t.after(() => bridge.stop())

  await appendJsonLine(workspace.root, FILES.inboxDsh, codexMessage())
  await bridge.tick('test')

  assert.equal(delivered.length, 1)
  assert.equal(await readCursor(workspace.root, FILES.cursorDsh), 0)
  const reasons = bridge.snapshot().instance.reasons.map((reason) => reason.code)
  assert.ok(reasons.includes('dsh:session-not-found'))
  assert.equal(bridge.snapshot().dsh.sessionId, SESSION_ID)
})

test('invalid and partial records never block later valid messages', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge, delivered } = makeBridge(workspace)
  await bridge.start()
  t.after(() => bridge.stop())

  const file = path.join(workspace.root, FILES.inboxDsh)
  await fs.appendFile(file, 'not json\n{"broken":true}\n')
  await fs.appendFile(file, JSON.stringify(codexMessage('valid one')) + '\n')
  await fs.appendFile(file, '{"half":')

  await bridge.tick('test')

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].text, 'valid one')
  const parked = await readRecords(workspace.root, FILES.parked)
  assert.ok(parked.records.some((record) => record.code === 'invalid-json'))
  assert.ok(parked.records.some((record) => record.code === 'invalid-object' || record.code.startsWith('invalid-')))
  assert.equal(bridge.snapshot().queue.codexToDsh, 0)
})

test('STOP pauses delivery without advancing the cursor', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge, delivered } = makeBridge(workspace)
  await bridge.start()
  t.after(() => bridge.stop())

  await appendJsonLine(workspace.root, FILES.inboxDsh, codexMessage('queued while stopped'))
  await writeFileAtomic(path.join(workspace.root, FILES.stop), 'stop\n')

  await bridge.tick('test')
  assert.equal(delivered.length, 0)
  assert.equal(await readCursor(workspace.root, FILES.cursorDsh), 0)
  assert.equal(bridge.snapshot().stop, true)

  await fs.unlink(path.join(workspace.root, FILES.stop))
  await bridge.tick('test')
  assert.equal(delivered.length, 1)
  assert.equal(bridge.snapshot().stop, false)
})

test('a wrong dshSessionId stays not-ready instead of throwing', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge } = makeBridge(workspace, {
    config: undefined,
    overrides: { dshSessionId: 'not-a-session' },
    probeSession: async () => ({ ok: false, code: 'session/not-found' }),
  })
  await bridge.start()
  t.after(() => bridge.stop())

  assert.equal(bridge.ready, false)
  const send = await bridge.send('hello')
  assert.equal(send.status, 'error')
  assert.equal(send.code, 'not-ready')
})
