import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { findRollout, projectRecord, readRecordsSince, runQueuedTurn } from '../lib/codex-queue.js'
import { FILES, readRecords } from '../lib/mailbox.js'
import {
  baseConfig,
  makeWorkspace,
  okProbeCodex,
  okProbeSession,

  SESSION_ID,
  startBridge,
  waitFor,
} from './helpers.mjs'

const THREAD = '77777777-6666-4555-8444-333333333333'

function rolloutLine(type, payload) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n'
}

async function makeCodexHome(base) {
  const home = path.join(base, 'codex-home')
  const dir = path.join(home, 'sessions', '2026', '11', '05')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-11-05T10-00-00-${THREAD}.jsonl`)
  await fsp.writeFile(file, '')
  return { home, file }
}

async function queueMessage(workspace, text) {
  const id = crypto.randomUUID()
  const record = {
    id,
    at: new Date().toISOString(),
    from: 'dsh',
    to: 'codex',
    kind: 'message',
    text,
    hops: 1,
    replyTo: null,
  }
  await fsp.appendFile(path.join(workspace.root, FILES.inboxCodex), JSON.stringify(record) + '\n')
  return { id }
}

test('projectRecord projects the rollout events the bridge relies on', () => {
  const user = projectRecord({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-1',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'hi' }] },
    },
  })
  assert.deepEqual(user, { kind: 'user_message', turnId: 'turn-1', text: 'hi' })

  const agent = projectRecord({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-1',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'pong' }], phase: 'final_answer' },
    },
  })
  assert.equal(agent.kind, 'agent_message')
  assert.equal(agent.text, 'pong')

  const done = projectRecord({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'pong' },
  })
  assert.deepEqual(done, { kind: 'task_complete', turnId: 'turn-1', lastAgentMessage: 'pong' })
})

test('findRollout locates the rollout for a thread', async (t) => {
  const workspace = await makeWorkspace(t)
  const { home, file } = await makeCodexHome(workspace.base)
  assert.equal(await findRollout(home, THREAD), file)
  assert.equal(await findRollout(home, '00000000-0000-0000-0000-000000000000'), null)
})

test('readRecordsSince reads complete lines and leaves the torn tail', async (t) => {
  const workspace = await makeWorkspace(t)
  const { file } = await makeCodexHome(workspace.base)
  await fsp.writeFile(file, rolloutLine('event_msg', { type: 'task_started', turn_id: 't1' }))
  const first = await readRecordsSince(file, 0)
  assert.equal(first.records.length, 1)
  await fsp.appendFile(file, '{"partial":')
  const second = await readRecordsSince(file, first.nextOffset)
  assert.equal(second.records.length, 0)
  await fsp.appendFile(file, 'true}\n')
  const third = await readRecordsSince(file, second.nextOffset)
  assert.equal(third.records.length, 1)
})

test('runQueuedTurn injects through queue and reads the answer from the rollout', async (t) => {
  const workspace = await makeWorkspace(t)
  const { home, file } = await makeCodexHome(workspace.base)
  const messageId = crypto.randomUUID()
  const marker = `id: ${messageId}`
  const text = `[codex-bridge]\n${marker}\n\nhello`

  const queueCommand = async ({ marker: seenMarker }) => {
    assert.equal(seenMarker, marker)
    await fsp.appendFile(file, rolloutLine('event_msg', {
      type: 'task_started',
      turn_id: 'turn-q1',
      turn_attribution: { turn_id: 'turn-q1', turn_trigger: 'queue' },
    }))
    await fsp.appendFile(file, rolloutLine('event_msg', {
      type: 'item_completed',
      turn_id: 'turn-q1',
      item: { type: 'UserMessage', content: [{ type: 'text', text }] },
    }))
    await fsp.appendFile(file, rolloutLine('event_msg', {
      type: 'item_completed',
      turn_id: 'turn-q1',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'queued pong' }], phase: 'final_answer' },
    }))
    await fsp.appendFile(file, rolloutLine('event_msg', { type: 'task_complete', turn_id: 'turn-q1' }))
    return { ok: true, queuedId: 'q-1' }
  }

  const result = await runQueuedTurn({
    executable: 'unused',
    threadId: THREAD,
    text,
    marker,
    codexHome: home,
    timeoutMs: 3000,
    pollMs: 10,
    queueCommand,
  })
  assert.equal(result.ok, true)
  assert.equal(result.replyText, 'queued pong')
  assert.equal(result.turnId, 'turn-q1')
  assert.equal(result.sessionId, THREAD)
})

test('runQueuedTurn ignores a rollout turn that is not ours', async (t) => {
  const workspace = await makeWorkspace(t)
  const { home, file } = await makeCodexHome(workspace.base)
  const marker = 'id: 123e4567-e89b-12d3-a456-426614174000'

  const queueCommand = async () => {
    await fsp.appendFile(file, rolloutLine('event_msg', { type: 'task_started', turn_id: 'other' }))
    await fsp.appendFile(file, rolloutLine('event_msg', {
      type: 'item_completed',
      turn_id: 'other',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'not mine' }], phase: 'final_answer' },
    }))
    return { ok: true, queuedId: 'q-2' }
  }

  const result = await runQueuedTurn({
    executable: 'unused',
    threadId: THREAD,
    text: `[codex-bridge]\n${marker}\n\nhello`,
    marker,
    codexHome: home,
    timeoutMs: 300,
    pollMs: 10,
    queueCommand,
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.replyText, '')
})

test('a route with transport=queue uses queueRunner and appends the reply', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = baseConfig(workspace, {
    routes: [{
      id: 'default',
      dshSessionId: SESSION_ID,
      codexWorkingDirectory: workspace.cwd,
      codexSessionId: THREAD,
      transport: 'queue',
    }],
  })
  const calls = []
  const { bridge } = await startBridge(workspace, {
    config,
    probeSession: okProbeSession,
    probeCodex: okProbeCodex,
    runner: async () => {
      throw new Error('exec runner must not be used for transport=queue')
    },
    queueRunner: async (options) => {
      calls.push(options)
      return { ok: true, replyText: 'queued reply', sessionId: THREAD, completed: true, sawAnyEvent: true }
    },
  })
  const queued = await queueMessage(workspace, 'hello queue')
  await bridge.tick('test')
  await waitFor(async () => (await readRecords(workspace.root, FILES.inboxDsh)).records.length === 1)
  const replies = (await readRecords(workspace.root, FILES.inboxDsh)).records
  assert.equal(calls.length, 1)
  assert.equal(calls[0].threadId, THREAD)
  assert.match(calls[0].marker, /^id: /)
  assert.equal(replies[0].kind, 'reply')
  assert.equal(replies[0].replyTo, queued.id)
  assert.equal(replies[0].text, 'queued reply')
  const meta = JSON.parse(fs.readFileSync(path.join(workspace.root, FILES.repliesDir, `${queued.id}.json`), 'utf8'))
  assert.equal(meta.codexSessionId, THREAD)
  assert.equal(bridge.bindingFor('default'), THREAD)
  await bridge.stop()
})

test('auto transport falls back to queue only on an active-writer error', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = baseConfig(workspace, {
    routes: [{
      id: 'default',
      dshSessionId: SESSION_ID,
      codexWorkingDirectory: workspace.cwd,
      codexSessionId: THREAD,
      transport: 'auto',
    }],
  })
  let execCalls = 0
  let queueCalls = 0
  const { bridge } = await startBridge(workspace, {
    config,
    probeSession: okProbeSession,
    probeCodex: okProbeCodex,
    runner: async () => {
      execCalls += 1
      return { ok: false, errorCode: 'codex:session-busy', stderrHint: 'codex:session-busy', sawAnyEvent: false }
    },
    queueRunner: async () => {
      queueCalls += 1
      return { ok: true, replyText: 'fallback reply', sessionId: THREAD, completed: true, sawAnyEvent: true }
    },
  })
  await queueMessage(workspace, 'hello fallback')
  await bridge.tick('test')
  await waitFor(async () => (await readRecords(workspace.root, FILES.inboxDsh)).records.length === 1)
  assert.equal(execCalls, 1)
  assert.equal(queueCalls, 1)
  assert.equal((await readRecords(workspace.root, FILES.inboxDsh)).records[0].text, 'fallback reply')
  await bridge.stop()
})
