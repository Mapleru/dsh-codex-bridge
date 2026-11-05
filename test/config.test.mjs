import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from '../lib/config.js'

const base = {
  root: path.join('C:', 'work', 'mailbox'),
  dshSessionId: '11111111-2222-4333-8444-555555555555',
  codexExecutable: path.join('C:', 'Program Files', 'codex.exe'),
  codexWorkingDirectory: path.join('C:', 'work'),
}

test('defaults match the documented values', () => {
  assert.equal(DEFAULT_CONFIG.codexTimeoutMs, 900000)
  assert.equal(DEFAULT_CONFIG.maxHops, 6)
  assert.equal(DEFAULT_CONFIG.maxQueueDepth, 20)
  assert.equal(DEFAULT_CONFIG.maxMessageBytes, 32768)
  assert.equal(DEFAULT_CONFIG.maxMailboxBytes, 8 * 1024 * 1024)
})

test('normalizeConfig clamps integers and trims strings', () => {
  const config = normalizeConfig({
    ...base,
    maxHops: 99999,
    maxAttempts: 0,
    pollIntervalMs: 'not-a-number',
    model: '  gpt-test  ',
  })
  assert.equal(config.maxHops, 1000)
  assert.equal(config.maxAttempts, 1)
  assert.equal(config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs)
  assert.equal(config.model, 'gpt-test')
})

test('validates a mailbox inside the Codex working directory', () => {
  const result = validateConfig(normalizeConfig(base))
  assert.equal(result.ok, true)
  assert.deepEqual(result.reasons, [])
})

test('reports missing and relative paths without throwing', () => {
  const empty = validateConfig(normalizeConfig({}))
  assert.equal(empty.ok, false)
  const codes = empty.reasons.map((reason) => reason.code)
  for (const code of [
    'config:root-missing',
    'config:session-missing',
    'config:executable-missing',
    'config:cwd-missing',
  ]) {
    assert.ok(codes.includes(code), `missing ${code}`)
  }

  const relative = validateConfig(normalizeConfig({ ...base, root: 'mailbox', codexExecutable: 'codex.exe' }))
  assert.ok(relative.reasons.some((reason) => reason.code === 'config:root-not-absolute'))
  assert.ok(relative.reasons.some((reason) => reason.code === 'config:executable-not-absolute'))
})

test('rejects a mailbox outside the Codex sandbox root', () => {
  const outside = validateConfig(
    normalizeConfig({ ...base, root: path.join('C:', 'elsewhere', 'mailbox') }),
  )
  assert.equal(outside.ok, false)
  assert.ok(outside.reasons.some((reason) => reason.code === 'config:root-outside-cwd'))
})

test('rejects a message limit larger than the mailbox limit', () => {
  const result = validateConfig(normalizeConfig({ ...base, maxMessageBytes: 200000, maxMailboxBytes: 100000 }))
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.code === 'config:message-larger-than-mailbox'))
})
