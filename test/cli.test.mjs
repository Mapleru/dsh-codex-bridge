import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { appendJsonLine, ensureLayout, FILES, readCursor, readRecords, writeCursor, writeJsonAtomic } from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { makeBridge, makeWorkspace } from './helpers.mjs'

const PACKAGE = path.dirname(fileURLToPath(import.meta.url))
const SEND = path.join(PACKAGE, '..', 'tools', 'send.mjs')
const CTL = path.join(PACKAGE, '..', 'tools', 'ctl.mjs')

// execFile's `input` option does not close the child's stdin reliably on this
// Windows/Node build (the child is killed by the timeout), so drive stdin by hand.
function runCli(script, args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
}

async function send(root, args, stdin = '') {
  const result = await runCli(SEND, ['--to', 'dsh', '--root', root, ...args], stdin)
  const text = result.stdout.trim()
  return { ...result, json: text ? JSON.parse(text) : null }
}

test('send.mjs queues a message written to stdin', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const result = await send(root, [], 'hello from codex\n')
  assert.equal(result.code, 0)
  assert.equal(result.json.status, 'queued')
  assert.equal(result.json.hops, 1)

  const { records } = await readRecords(root, FILES.inboxDsh)
  assert.equal(records.length, 1)
  assert.equal(records[0].from, 'codex')
  assert.equal(records[0].text, 'hello from codex')
})

test('send.mjs reads the body from a file and dedupes within the pending window', async (t) => {
  const { root, base } = await makeWorkspace(t)
  await ensureLayout(root)
  const file = path.join(base, 'body.txt')
  await fs.writeFile(file, 'file body')

  const first = await send(root, ['--file', file])
  assert.equal(first.json.status, 'queued')
  const second = await send(root, ['--file', file])
  assert.equal(second.json.status, 'duplicate')
  assert.equal(second.json.id, first.json.id)
  assert.equal((await readRecords(root, FILES.inboxDsh)).records.length, 1)
})

test('send.mjs rejects unknown reply targets and oversized bodies', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)

  const unknown = await send(root, ['--reply-to', '00000000-0000-4000-8000-000000000000'], 'x')
  assert.equal(unknown.code, 3)
  assert.equal(unknown.json.code, 'reply-target-unknown')

  const huge = await send(root, ['--max-bytes', '10'], 'x'.repeat(100))
  assert.equal(huge.code, 3)
  assert.equal(huge.json.code, 'message-too-large')

  const empty = await send(root, [], '   ')
  assert.equal(empty.code, 3)
  assert.equal(empty.json.code, 'empty-body')
})

test('send.mjs reports busy when the mailbox is full', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  await fs.writeFile(path.join(root, FILES.inboxDsh), 'x'.repeat(9 * 1024 * 1024) + '\n')
  const result = await send(root, [], 'blocked')
  assert.equal(result.code, 2)
  assert.equal(result.json.code, 'busy')
})

test('reply hops are computed from the parent and cannot be reset', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const parent = makeMessage({ from: 'codex', to: 'dsh', text: 'parent', hops: 3 })
  await appendJsonLine(root, FILES.inboxDsh, parent)

  const result = await send(root, ['--reply-to', parent.id], 'child')
  assert.equal(result.json.status, 'queued')
  assert.equal(result.json.hops, 4)
})

test('ctl stop, status, parked and resume operate on the mailbox', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  await writeJsonAtomic(path.join(root, FILES.state), { instance: { ready: true }, stop: false })

  const status = await runCli(CTL, ['status', '--root', root])
  assert.match(status.stdout, /"ready": true/)

  const stop = await runCli(CTL, ['stop', '--root', root])
  assert.equal(stop.code, 0)
  assert.equal((await fs.stat(path.join(root, FILES.stop))).isFile(), true)

  const resume = await runCli(CTL, ['resume', '--root', root])
  assert.equal(resume.code, 0)
  await assert.rejects(fs.stat(path.join(root, FILES.stop)))

  const parkedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await appendJsonLine(root, FILES.parked, {
    at: new Date().toISOString(),
    code: 'delivery-uncertain',
    messageId: parkedId,
    cursorAfter: 10,
  })
  const parked = await runCli(CTL, ['parked', '--root', root])
  assert.match(parked.stdout, /delivery-uncertain/)

  const refused = await runCli(CTL, ['retry', parkedId, '--root', root])
  assert.equal(refused.code, 3)

  const retried = await runCli(CTL, ['retry', parkedId, '--confirm-uncertain', '--root', root])
  assert.equal(retried.code, 0)
  assert.match(retried.stdout, /retried 1 record/)
  assert.equal(await readCursor(root, FILES.cursorCodex), 10)
})

test('ctl retry rewinds to the start of the message, not its end', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const message = makeMessage({ from: 'dsh', to: 'codex', text: 'retry me' })
  await appendJsonLine(root, FILES.inboxCodex, message)
  const end = (await fs.stat(path.join(root, FILES.inboxCodex))).size
  await appendJsonLine(root, FILES.parked, {
    at: new Date().toISOString(),
    code: 'session-lost',
    messageId: message.id,
    cursorAfter: end,
  })
  await writeCursor(root, FILES.cursorCodex, end)

  const retried = await runCli(CTL, ['retry', message.id, '--root', root])
  assert.equal(retried.code, 0)
  assert.equal(await readCursor(root, FILES.cursorCodex), 0)
})

test('ctl receipt finds the outbound reply and the Codex acknowledgement', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  const request = makeMessage({ from: 'codex', to: 'dsh', text: 'ping', route: 'default' })
  await appendJsonLine(root, FILES.inboxDsh, request)
  const outbound = makeMessage({ from: 'dsh', to: 'codex', text: 'pong', replyTo: request.id, hops: 2 })
  await appendJsonLine(root, FILES.inboxCodex, outbound)
  await fs.writeFile(path.join(root, FILES.repliesDir, `${outbound.id}.txt`), 'ack' + String.fromCharCode(10))
  await fs.writeFile(
    path.join(root, FILES.repliesDir, `${outbound.id}.json`),
    JSON.stringify({
      messageId: outbound.id,
      replyId: 'ffffffff-1111-4222-8333-444444444444',
      replyTo: outbound.id,
      route: 'default',
      hops: 3,
      status: 'completed',
      savedAt: new Date().toISOString(),
      appendedAt: new Date().toISOString(),
      codexSessionId: '99999999-8888-4777-8666-555555555555',
    }),
  )

  const receipt = await runCli(CTL, ['receipt', request.id, '--root', root])
  assert.equal(receipt.code, 0)
  assert.match(receipt.stdout, /"direction":"dsh-to-codex"/)
  assert.match(receipt.stdout, /pong/)
  assert.match(receipt.stdout, /"direction":"codex-to-dsh"/)
  assert.match(receipt.stdout, /ack/)
})

test('a second bridge on the same root stays lazy and consumes nothing', async (t) => {
  const workspace = await makeWorkspace(t)
  const first = makeBridge(workspace)
  await first.bridge.start()
  t.after(() => first.bridge.stop())

  const second = makeBridge(workspace)
  await second.bridge.start()
  t.after(() => second.bridge.stop())

  assert.equal(second.bridge.snapshot().instance.lock, 'locked')
  assert.equal(second.bridge.ready, false)

  await appendJsonLine(workspace.root, FILES.inboxDsh, makeMessage({ from: 'codex', to: 'dsh', text: 'one copy' }))
  await first.bridge.tick('test')
  await second.bridge.tick('test')

  assert.equal(first.delivered.length, 1)
  assert.equal(second.delivered.length, 0)
  assert.equal((await readCursor(workspace.root, FILES.cursorDsh)) > 0, true)
})

test('separate processes appending at the same time never interleave bytes', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)

  const bodies = Array.from({ length: 6 }, (_value, index) => `process body ${index} ${'x'.repeat(200)}`)
  const results = await Promise.all(bodies.map((body) => send(root, [], body)))
  assert.equal(results.every((result) => result.code === 0 && result.json.status === 'queued'), true)

  const raw = await fs.readFile(path.join(root, FILES.inboxDsh), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 6)
  const texts = lines.map((line) => JSON.parse(line).text).sort()
  assert.deepEqual(texts, [...bodies].sort())
})

test('send.mjs refuses to queue while STOP is present', async (t) => {
  const { root } = await makeWorkspace(t)
  await ensureLayout(root)
  await fs.writeFile(path.join(root, FILES.stop), '')

  const result = await send(root, [], 'while stopped')
  assert.equal(result.code, 3)
  assert.equal(result.json.code, 'stop')
  assert.equal((await fs.stat(path.join(root, FILES.inboxDsh))).size, 0)
})
