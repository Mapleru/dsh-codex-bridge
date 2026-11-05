import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  appendJsonLine,
  ensureLayout,
  FILES,
  readCursor,
  readJsonFile,
  readRecords,
  writeCursor,
  writeFileAtomic,
  writeJsonAtomic,
} from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { makeBridge, makeWorkspace, waitFor } from './helpers.mjs'

const THREAD = '99999999-8888-4777-8666-555555555555'

async function setup(workspace, options = {}) {
  const made = makeBridge(workspace, options)
  await made.bridge.start()
  return made
}

test('one Codex call produces a stable reply and advances the input cursor', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const { bridge } = await setup(workspace, {
    runner: async (options) => {
      calls.push(options)
      return { ok: true, completed: true, replyText: 'codex answer', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())

  const queued = await bridge.send('question for codex')
  assert.equal(queued.status, 'queued')
  await bridge.tick('test')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].stdinText.includes('question for codex'), true)
  assert.equal(calls[0].args.includes('resume'), false)
  assert.equal(bridge.sessionId, THREAD)

  const { records } = await readRecords(workspace.root, FILES.inboxDsh)
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'reply')
  assert.equal(records[0].replyTo, queued.id)
  assert.equal(records[0].hops, 2)
  assert.equal(records[0].text, 'codex answer')

  const cursor = await readCursor(workspace.root, FILES.cursorCodex)
  assert.ok(cursor > 0)
  assert.equal(await pathExists(path.join(workspace.root, FILES.processing)), false)

  const meta = await readJsonFile(path.join(workspace.root, FILES.repliesDir, `${queued.id}.json`), null)
  assert.equal(meta.status, 'completed')
  assert.equal(meta.appendedAt !== undefined, true)
})

test('the second message resumes the recorded thread instead of starting a new one', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const runner = async (options) => {
    calls.push(options)
    return { ok: true, completed: true, replyText: `answer ${calls.length}`, sessionId: THREAD }
  }
  const first = await setup(workspace, { runner })
  await first.bridge.send('first')
  await first.bridge.tick('test')
  await first.bridge.stop()

  const second = await setup(workspace, { runner })
  t.after(() => second.bridge.stop())
  await second.bridge.send('second')
  await second.bridge.tick('test')

  assert.equal(calls.length, 2)
  const resumeAt = calls[1].args.indexOf('resume')
  assert.ok(resumeAt >= 0)
  assert.equal(calls[1].args[resumeAt + 1], THREAD)
  assert.equal(second.bridge.sessionId, THREAD)
})

test('pre-start failures retry and then park without advancing past the record', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const { bridge } = await setup(workspace, {
    runner: async () => {
      calls.push(1)
      return { ok: false, errorCode: 'codex:not-found', sawAnyEvent: false }
    },
  })
  t.after(() => bridge.stop())

  const queued = await bridge.send('will fail')
  await bridge.tick('test')

  assert.equal(calls.length, 2)
  const parked = await readRecords(workspace.root, FILES.parked)
  const record = parked.records.find((entry) => entry.messageId === queued.id)
  assert.equal(record.code, 'failed')
  assert.ok(await readCursor(workspace.root, FILES.cursorCodex) > 0)
  assert.equal(bridge.snapshot().queue.dshToCodex, 0)
})

test('a timeout is parked as delivery-uncertain and never re-run automatically', async (t) => {
  const workspace = await makeWorkspace(t)
  let calls = 0
  const first = await setup(workspace, {
    runner: async () => {
      calls += 1
      return { ok: false, timedOut: true, errorCode: 'codex:timeout', sawAnyEvent: true, events: 3 }
    },
  })
  const queued = await first.bridge.send('long job')
  await first.bridge.tick('test')
  await first.bridge.stop()
  assert.equal(calls, 1)

  const parked = await readRecords(workspace.root, FILES.parked)
  assert.equal(parked.records.find((record) => record.messageId === queued.id)?.code, 'delivery-uncertain')

  const second = await setup(workspace, {
    runner: async () => {
      calls += 1
      return { ok: true, completed: true, replyText: 'must not happen', sessionId: THREAD }
    },
  })
  t.after(() => second.bridge.stop())
  await second.bridge.tick('test')
  assert.equal(calls, 1)
})

test('a restart mid-call parks delivery-uncertain without calling Codex again', async (t) => {
  const workspace = await makeWorkspace(t)
  await ensureLayout(workspace.root)
  const message = makeMessage({ from: 'dsh', to: 'codex', text: 'in flight', hops: 1 })
  const line = `${JSON.stringify(message)}\n`
  await writeFileAtomic(path.join(workspace.root, FILES.inboxCodex), line)
  await writeCursor(workspace.root, FILES.cursorCodex, 0)
  await writeJsonAtomic(path.join(workspace.root, FILES.processing), {
    messageId: message.id,
    phase: 'running',
    startedAt: new Date().toISOString(),
    cursorAfter: Buffer.byteLength(line),
    hops: 1,
    replyTo: null,
  })

  let calls = 0
  const { bridge } = await setup(workspace, {
    runner: async () => {
      calls += 1
      return { ok: true, completed: true, replyText: 'replayed', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())
  await bridge.tick('test')

  assert.equal(calls, 0)
  const parked = await readRecords(workspace.root, FILES.parked)
  assert.equal(parked.records.find((record) => record.messageId === message.id)?.code, 'delivery-uncertain')
  assert.equal(bridge.snapshot().queue.dshToCodex, 0)
})

test('a restart with a saved reply reuses it and appends exactly one reply', async (t) => {
  const workspace = await makeWorkspace(t)
  await ensureLayout(workspace.root)
  const message = makeMessage({ from: 'dsh', to: 'codex', text: 'already answered', hops: 1 })
  const line = `${JSON.stringify(message)}\n`
  await writeFileAtomic(path.join(workspace.root, FILES.inboxCodex), line)
  await writeCursor(workspace.root, FILES.cursorCodex, 0)
  await writeFileAtomic(path.join(workspace.root, FILES.repliesDir, `${message.id}.txt`), 'saved answer')
  await writeJsonAtomic(path.join(workspace.root, FILES.repliesDir, `${message.id}.json`), {
    messageId: message.id,
    replyId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    replyTo: message.id,
    hops: 2,
    status: 'reply_saved',
  })
  await writeJsonAtomic(path.join(workspace.root, FILES.processing), {
    messageId: message.id,
    phase: 'reply_saved',
    cursorAfter: Buffer.byteLength(line),
    hops: 1,
    replyTo: null,
  })

  let calls = 0
  const { bridge } = await setup(workspace, {
    runner: async () => {
      calls += 1
      return { ok: true, completed: true, replyText: 'new answer', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())
  await bridge.tick('test')

  assert.equal(calls, 0)
  const { records } = await readRecords(workspace.root, FILES.inboxDsh)
  assert.equal(records.length, 1)
  assert.equal(records[0].text, 'saved answer')
  assert.equal(records[0].id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
  assert.ok(await readCursor(workspace.root, FILES.cursorCodex) > 0)
})

test('hop limit parks the message without calling Codex', async (t) => {
  const workspace = await makeWorkspace(t)
  await ensureLayout(workspace.root)
  const message = makeMessage({ from: 'dsh', to: 'codex', text: 'too deep', hops: 6 })
  await appendJsonLine(workspace.root, FILES.inboxCodex, message)

  let calls = 0
  const { bridge } = await setup(workspace, {
    runner: async () => {
      calls += 1
      return { ok: true, completed: true, replyText: 'x', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())
  await bridge.tick('test')

  assert.equal(calls, 0)
  const parked = await readRecords(workspace.root, FILES.parked)
  assert.equal(parked.records.find((record) => record.messageId === message.id)?.code, 'hop-limit')
})

test('a full Codex queue answers busy and does not drop the message', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge } = await setup(workspace, { overrides: { maxQueueDepth: 1 } })
  t.after(() => bridge.stop())

  const first = await bridge.send('one')
  assert.equal(first.status, 'queued')
  const second = await bridge.send('two')
  assert.equal(second.status, 'busy')
  assert.equal(second.code, 'queue-full')
  assert.equal(second.queueDepth, 1)

  const { records } = await readRecords(workspace.root, FILES.inboxCodex)
  assert.equal(records.length, 1)
})

test('an oversized reply is parked instead of truncating', async (t) => {
  const workspace = await makeWorkspace(t)
  const { bridge } = await setup(workspace, {
    overrides: { maxMessageBytes: 512, maxMailboxBytes: 8192 },
    runner: async () => ({ ok: true, completed: true, replyText: 'x'.repeat(600), sessionId: THREAD }),
  })
  t.after(() => bridge.stop())

  const first = await bridge.send('small request')
  const oversizedSend = await bridge.send('y'.repeat(600))
  assert.equal(oversizedSend.status, 'error')
  assert.equal(oversizedSend.code, 'message-too-large')

  await bridge.tick('test')
  const parked = await readRecords(workspace.root, FILES.parked)
  assert.equal(parked.records.find((record) => record.messageId === first.id)?.code, 'reply-too-large')
  const { records } = await readRecords(workspace.root, FILES.inboxDsh)
  assert.equal(records.length, 0)
})

test('STOP aborts the running call and keeps the message pending', async (t) => {
  const workspace = await makeWorkspace(t)
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const { bridge } = await setup(workspace, {
    runner: async (options) => {
      started()
      return await new Promise((resolve) => {
        options.signal.addEventListener('abort', () => {
          resolve({ ok: false, aborted: true, errorCode: 'codex:aborted', sawAnyEvent: true })
        })
      })
    },
  })
  t.after(() => bridge.stop())

  const queued = await bridge.send('abort me')
  const ticking = bridge.tick('test')
  await startedPromise
  await writeFileAtomic(path.join(workspace.root, FILES.stop), 'stop\n')
  await bridge.observeStop()
  await ticking

  assert.equal(await readCursor(workspace.root, FILES.cursorCodex), 0)
  const processing = await readJsonFile(path.join(workspace.root, FILES.processing), null)
  assert.equal(processing.messageId, queued.id)
  assert.equal(processing.phase, 'stopped')
  assert.equal(bridge.snapshot().stop, true)
})

async function pathExists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

test('an operator cursor rewind is picked up by the running bridge', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const { bridge } = await setup(workspace, {
    runner: async (options) => {
      calls.push(options)
      return { ok: true, completed: true, replyText: 'ok', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())

  await bridge.send('first question')
  await bridge.tick('first')
  const afterFirst = bridge.cursorCodex
  await bridge.send('second question')
  await bridge.tick('second')
  assert.equal(calls.length, 2)

  // ctl.mjs retry rewinds the on-disk cursor; a live bridge must notice.
  await writeCursor(workspace.root, FILES.cursorCodex, afterFirst)
  await bridge.tick('after-retry')
  assert.equal(calls.length, 3)
  assert.match(calls[2].stdinText, /second question/)
})

const OTHER_THREAD = '77777777-6666-4555-8444-333333333333'

test('a ctl bind written while the bridge is idle is used by the next call', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const { bridge } = await setup(workspace, {
    runner: async (options) => {
      calls.push(options)
      return { ok: true, completed: true, replyText: 'bound', sessionId: OTHER_THREAD }
    },
  })
  t.after(() => bridge.stop())
  await bridge.tick('warm')

  // ctl.mjs bind writes routes.json behind the plugin's back.
  await writeJsonAtomic(path.join(workspace.root, FILES.routes), {
    version: 1,
    routes: { default: { codexSessionId: OTHER_THREAD, updatedAt: new Date().toISOString() } },
  })

  await bridge.send('after bind')
  await bridge.tick('bind')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(0, 4), ['--no-daemon', '-s', 'workspace-write', '-C'])
  assert.ok(calls[0].args.includes('resume'))
  assert.equal(calls[0].args[calls[0].args.indexOf('resume') + 1], OTHER_THREAD)
})

test('a bind that lands mid-call is not clobbered by the finishing call', async (t) => {
  const workspace = await makeWorkspace(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let started
  const running = new Promise((resolve) => { started = resolve })
  const { bridge } = await setup(workspace, {
    runner: async () => {
      started()
      await gate
      return { ok: true, completed: true, replyText: 'late', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())

  await bridge.send('slow question')
  const tick = bridge.tick('slow')
  await running

  await writeJsonAtomic(path.join(workspace.root, FILES.routes), {
    version: 1,
    routes: { default: { codexSessionId: OTHER_THREAD, updatedAt: new Date().toISOString() } },
  })
  release()
  await tick

  const routes = await readJsonFile(path.join(workspace.root, FILES.routes), null)
  assert.equal(routes.routes.default.codexSessionId, OTHER_THREAD)
  const meta = await readJsonFile(path.join(workspace.root, FILES.repliesDir, `${bridge.lastReplyId ?? ''}.json`), null)
  assert.equal(meta, null) // sanity: unknown id is simply absent
})

test('a successful turn clears a stale route error code', async (t) => {
  const workspace = await makeWorkspace(t)
  await ensureLayout(workspace.root)
  // A previous loss left `code` behind while the binding itself was fine.
  await writeJsonAtomic(path.join(workspace.root, FILES.routes), {
    version: 1,
    routes: {
      default: {
        codexSessionId: THREAD,
        code: 'codex:session-lost',
        updatedAt: new Date().toISOString(),
      },
    },
  })
  const { bridge } = await setup(workspace, {
    runner: async () => ({ ok: true, completed: true, replyText: 'recovered', sessionId: THREAD }),
  })
  t.after(() => bridge.stop())

  await bridge.send('are you back?')
  await bridge.tick('test')

  const routes = await readJsonFile(path.join(workspace.root, FILES.routes), null)
  assert.equal(routes.routes.default.codexSessionId, THREAD)
  assert.equal('code' in routes.routes.default, false)
})
