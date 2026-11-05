import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  acquireInstanceLock,
  appendJsonLine,
  ensureLayout,
  FILES,
  findReplyTo,
  isMailboxError,
  readBatch,
  readCursor,
  readRecords,
  releaseInstanceLock,
  writeCursor,
} from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { makeWorkspace } from './helpers.mjs'

test('reads only complete lines and leaves a half-written record', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const file = path.join(root, FILES.inboxCodex)
  await fs.writeFile(file, '{"a":1}\n{"b":2}\n{"partial"')

  const batch = await readBatch(root, FILES.inboxCodex, 0, { maxLines: 10 })
  assert.equal(batch.lines.length, 2)
  assert.equal(batch.nextCursor, Buffer.byteLength('{"a":1}\n{"b":2}\n'))

  await fs.appendFile(file, ':true}\n')
  const next = await readBatch(root, FILES.inboxCodex, batch.nextCursor, { maxLines: 10 })
  assert.equal(next.lines.length, 1)
  assert.equal(JSON.parse(next.lines[0].raw).partial, true)
})

test('concurrent appends never interleave bytes', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const writers = 12
  await Promise.all(
    Array.from({ length: writers }, (_, index) =>
      appendJsonLine(root, FILES.inboxCodex, { index, text: 'x'.repeat(200) }, { maxBytes: 8 * 1024 * 1024 }),
    ),
  )
  const { records, invalid } = await readRecords(root, FILES.inboxCodex)
  assert.equal(invalid, 0)
  assert.equal(records.length, writers)
  assert.deepEqual(
    records.map((record) => record.index).sort((a, b) => a - b),
    Array.from({ length: writers }, (_, index) => index),
  )
})

test('rotation happens only when the existing bytes are consumed', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const cursor = await readCursor(root, FILES.cursorCodex)
  assert.equal(cursor, 0)

  await appendJsonLine(root, FILES.inboxCodex, { n: 1 }, { maxBytes: 120, cursorFile: FILES.cursorCodex })
  await writeCursor(root, FILES.cursorCodex, (await fs.stat(path.join(root, FILES.inboxCodex))).size)

  // Consumed: the next append may rotate instead of failing.
  await appendJsonLine(root, FILES.inboxCodex, { n: 2 }, { maxBytes: 14, cursorFile: FILES.cursorCodex })
  const batch = await readBatch(root, FILES.inboxCodex, 0)
  assert.equal(batch.lines.length, 1)
  assert.equal(JSON.parse(batch.lines[0].raw).n, 2)

  // Unconsumed: append must fail with mailbox-full rather than drop data.
  await assert.rejects(
    appendJsonLine(root, FILES.inboxCodex, { n: 3 }, { maxBytes: 14, cursorFile: FILES.cursorCodex }),
    (error) => isMailboxError(error) && error.code === 'mailbox-full',
  )
})

test('findReplyTo dedupes by replyTo', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const parent = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const reply = makeMessage({ from: 'codex', to: 'dsh', text: 'r', hops: 2, replyTo: parent })
  await appendJsonLine(root, FILES.inboxDsh, reply)
  const found = await findReplyTo(root, parent)
  assert.equal(found?.id, reply.id)
  assert.equal(await findReplyTo(root, 'wrong'), null)
})

test('instance lock is exclusive and only the owner can release it', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const first = await acquireInstanceLock(root, { pid: process.pid, instanceId: 'one', startedAt: 'now' })
  assert.equal(first.acquired, true)

  const second = await acquireInstanceLock(root, { pid: process.pid, instanceId: 'two', startedAt: 'now' })
  assert.equal(second.acquired, false)

  const released = await releaseInstanceLock(root, 'two')
  assert.equal(released, false)
  const stillHeld = await acquireInstanceLock(root, { pid: process.pid, instanceId: 'three', startedAt: 'now' })
  assert.equal(stillHeld.acquired, false)

  assert.equal(await releaseInstanceLock(root, 'one'), true)
  const third = await acquireInstanceLock(root, { pid: process.pid, instanceId: 'four', startedAt: 'now' })
  assert.equal(third.acquired, true)
})
