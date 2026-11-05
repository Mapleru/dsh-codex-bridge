import assert from 'node:assert/strict'
import test from 'node:test'

import {
  makeMessage,
  promptRequestId,
  promptTextFor,
  validateMessage,
} from '../lib/protocol.js'

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PARENT = '12345678-1234-4234-8234-123456789012'

test('accepts a valid message and normalizes fields', () => {
  const check = validateMessage(
    {
      id: ID,
      at: '2026-11-05T00:00:00.000Z',
      from: 'codex',
      to: 'dsh',
      kind: 'message',
      text: 'hello',
      hops: 1,
      replyTo: null,
    },
    { from: 'codex', to: 'dsh', maxMessageBytes: 1024 },
  )
  assert.equal(check.ok, true)
  assert.equal(check.message.id, ID)
  assert.equal(check.message.kind, 'message')
})

test('rejects malformed records with a stable code', () => {
  const cases = [
    [{}, 'invalid-id'],
    [{ ...base(), id: 'nope' }, 'invalid-id'],
    [{ ...base(), at: 'not-a-date' }, 'invalid-at'],
    [{ ...base(), from: 'dsh' }, 'invalid-from'],
    [{ ...base(), to: 'codex' }, 'invalid-to'],
    [{ ...base(), kind: 'reply', replyTo: 'nope' }, 'invalid-reply-to'],
  ]
  for (const [value, code] of cases) {
    const check = validateMessage(value, { from: 'codex', to: 'dsh', maxMessageBytes: 1024 })
    assert.equal(check.ok, false, `${code} should be rejected`)
    assert.equal(check.code, code)
  }
})

test('enforces the byte limit and hop ceiling', () => {
  const tooBig = validateMessage({ ...base(), text: 'x'.repeat(2048) }, {
    from: 'codex',
    to: 'dsh',
    maxMessageBytes: 1024,
  })
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.code, 'message-too-large')

  const tooManyHops = validateMessage({ ...base(), hops: 1001 }, { from: 'codex', to: 'dsh', maxMessageBytes: 1024 })
  assert.equal(tooManyHops.ok, false)
  assert.equal(tooManyHops.code, 'invalid-hops')
})

test('makeMessage derives kind from replyTo and keeps a stable id', () => {
  const reply = makeMessage({ from: 'codex', to: 'dsh', text: 'r', hops: 2, replyTo: PARENT })
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.replyTo, PARENT)
  assert.match(reply.id, /^[0-9a-f-]{36}$/)

  const fresh = makeMessage({ from: 'dsh', to: 'codex', text: 'm', hops: 1 })
  assert.equal(fresh.kind, 'message')
  assert.equal(fresh.replyTo, null)
})

test('prompt text carries protocol headers and a stable request id', () => {
  const message = { id: ID, hops: 3, replyTo: PARENT, text: 'body text' }
  const text = promptTextFor(message)
  assert.match(text, /^\[codex-bridge\]\nid: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\nroute: default\nhops: 3\nreplyTo: 12345678/)
  assert.match(text, /\n\nbody text\n$/)
  assert.equal(promptRequestId(ID), `codex-bridge:${ID}`)
})

test('prompt request ids are idempotent per message id', () => {
  assert.equal(promptRequestId(ID), promptRequestId(ID))
  assert.notEqual(promptRequestId(ID), promptRequestId(PARENT))
})

function base() {
  return {
    id: ID,
    at: '2026-11-05T00:00:00.000Z',
    from: 'codex',
    to: 'dsh',
    kind: 'message',
    text: 'hello',
    hops: 1,
    replyTo: null,
  }
}
