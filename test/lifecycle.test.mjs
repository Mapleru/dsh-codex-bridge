import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { appendJsonLine, ensureLayout, FILES, readCursor, readJsonFile, readRecords, writeFileAtomic } from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { makeBridge, makeWorkspace, waitFor } from './helpers.mjs'

test('starting twice returns the same promise and never double-consumes', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace)
  const first = made.bridge.start()
  const second = made.bridge.start()
  await Promise.all([first, second])
  t.after(() => made.bridge.stop())

  assert.equal(await first, await second)

  await appendJsonLine(workspace.root, FILES.inboxDsh, makeMessage({ from: 'codex', to: 'dsh', text: 'once' }))
  await made.bridge.tick('test')
  await made.bridge.tick('test')
  assert.equal(made.delivered.length, 1)
})

test('stop closes the watcher, clears timers and is idempotent', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace, { watch: true, autoTick: true })
  await made.bridge.start()
  assert.ok(made.bridge.watcher)
  assert.ok(made.bridge.interval)

  await made.bridge.stop()
  assert.equal(made.bridge.watcher, null)
  assert.equal(made.bridge.interval, null)
  assert.equal(made.bridge.debounceTimer, null)

  await made.bridge.stop()
  const lock = await readJsonFile(path.join(workspace.root, FILES.lock), null)
  assert.equal(lock, null)
})

test('a stopped bridge ignores late messages and does not advance cursors', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace)
  await made.bridge.start()
  await made.bridge.stop()

  const before = await readCursor(workspace.root, FILES.cursorDsh)
  await appendJsonLine(workspace.root, FILES.inboxDsh, makeMessage({ from: 'codex', to: 'dsh', text: 'late' }))
  await made.bridge.tick('test')
  assert.equal(made.delivered.length, 0)
  assert.equal(await readCursor(workspace.root, FILES.cursorDsh), before)
})

test('the watcher notices a new message and delivers it promptly', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace, { watch: true })
  await made.bridge.start()
  t.after(() => made.bridge.stop())

  await appendJsonLine(workspace.root, FILES.inboxDsh, makeMessage({ from: 'codex', to: 'dsh', text: 'watched' }))
  await waitFor(() => made.delivered.length === 1, { timeoutMs: 5000 })
  assert.equal(made.delivered[0].text, 'watched')
})

test('STOP is noticed by the watcher even while idle', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace, { watch: true })
  await made.bridge.start()
  t.after(() => made.bridge.stop())

  await writeFileAtomic(path.join(workspace.root, FILES.stop), 'stop\n')
  await waitFor(() => made.bridge.snapshot().stop === true, { timeoutMs: 5000 })

  await fs.unlink(path.join(workspace.root, FILES.stop))
  await waitFor(() => made.bridge.snapshot().stop === false, { timeoutMs: 5000 })
})

test('work interrupted by STOP is parked as uncertain after resume, then the next message runs', async (t) => {
  const workspace = await makeWorkspace(t)
  await ensureLayout(workspace.root)
  let calls = 0
  const made = makeBridge(workspace, {
    runner: async (options) => {
      calls += 1
      if (calls === 1) {
        return await new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ ok: false, aborted: true, sawAnyEvent: true }))
        })
      }
      return { ok: true, completed: true, replyText: 'second answer', sessionId: '99999999-8888-4777-8666-555555555555' }
    },
  })
  await made.bridge.start()
  t.after(() => made.bridge.stop())

  const first = await made.bridge.send('first')
  const ticking = made.bridge.tick('test')
  await waitFor(() => calls === 1, { timeoutMs: 5000 })
  await writeFileAtomic(path.join(workspace.root, FILES.stop), 'stop\n')
  await made.bridge.observeStop()
  await ticking

  await fs.unlink(path.join(workspace.root, FILES.stop))
  const second = await made.bridge.send('second')
  await made.bridge.tick('test')

  assert.equal(calls, 2)
  const parked = await readRecords(workspace.root, FILES.parked)
  const record = parked.records.find((entry) => entry.messageId === first.id)
  assert.equal(record?.code, 'delivery-uncertain')

  const replies = (await readRecords(workspace.root, FILES.inboxDsh)).records
  assert.equal(replies.length, 1)
  assert.equal(replies[0].replyTo, second.id)
  assert.equal(replies[0].text, 'second answer')
})

test('bad configuration reports not-ready instead of throwing', async (t) => {
  const workspace = await makeWorkspace(t)
  const made = makeBridge(workspace, { overrides: { dshSessionId: '', codexExecutable: '' } })
  await made.bridge.start()
  t.after(() => made.bridge.stop())

  const snapshot = made.bridge.snapshot()
  assert.equal(snapshot.instance.ready, false)
  assert.ok(snapshot.instance.reasons.some((reason) => reason.code === 'config:session-missing'))
  const sent = await made.bridge.send('hello')
  assert.equal(sent.status, 'error')
  assert.equal(sent.code, 'not-ready')
})

test('the helper installer copies send.mjs and ctl.mjs with their lib into the mailbox', async (t) => {
  const workspace = await makeWorkspace(t)
  const helperSource = path.resolve('tools/send.mjs')
  const made = makeBridge(workspace, { helperSource })
  await made.bridge.start()
  t.after(() => made.bridge.stop())

  const toolsDir = path.join(workspace.root, FILES.toolsDir)
  for (const name of ['send.mjs', 'ctl.mjs', path.join('lib', 'mailbox.js'), path.join('lib', 'protocol.js')]) {
    const stats = await fs.stat(path.join(toolsDir, name))
    assert.equal(stats.isFile(), true, `${name} should be copied`)
  }
  const ctl = await fs.readFile(path.join(toolsDir, 'ctl.mjs'), 'utf8')
  assert.match(ctl, /loadMailbox/)
  assert.doesNotMatch(ctl, /from '\.\.\/lib\/mailbox\.js'/)
})
