import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { appendJsonLine, FILES, readRecords } from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'
import { baseConfig, makeWorkspace, SESSION_ID } from './helpers.mjs'

function fakeContext(sessionState = { accepted: true }) {
  const effects = []
  const tools = []
  const skills = []
  const prompts = []
  const followups = []
  const steers = []
  let disposed = false

  const controller = {
    async resolveAgent(sessionId) {
      if (sessionId !== SESSION_ID) return { error: { code: 'session/not-found' } }
      return {
        agent: {
          id: SESSION_ID,
          async followup(message) {
            followups.push({ sessionId, message })
          },
          async steer(message) {
            steers.push({ sessionId, message })
          },
        },
      }
    },
    async prompt(request) {
      prompts.push(request)
      if (sessionState.accepted) return { accepted: true }
      return { error: { code: sessionState.code ?? 'gateway/internal' } }
    },
  }

  const ctx = {
    get(name) {
      return name === 'sessionController' ? controller : undefined
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: {
      register(definition, options) {
        tools.push({ definition, options })
        return () => {
          definition.disposed = true
        }
      },
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['skills'])
      const fiber = callback({
        skills: {
          register(skill) {
            skills.push(skill)
            return () => {
              skill.disposed = true
            }
          },
        },
      })
      return {
        dispose() {
          fiber?.()
        },
      }
    },
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
  }

  return {
    ctx,
    tools,
    skills,
    prompts,
    followups,
    steers,
    effects,
    disposeAll() {
      disposed = true
      for (const effect of effects.reverse()) effect?.()
    },
    get disposed() {
      return disposed
    },
  }
}

async function settleDelivery(bridge, fake) {
  for (let i = 0; i < 10; i += 1) {
    await bridge.tick(`settle-${i}`)
    if (fake.prompts.length + fake.steers.length + fake.followups.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('apply registers both tools, the skill and lifecycle cleanup', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const config = baseConfig(workspace, {
    codexExecutable: path.join(workspace.base, 'missing-codex.exe'),
  })
  const bridge = apply(fake.ctx, config)
  await bridge.start()
  t.after(() => bridge.stop())

  const names = fake.tools.map((entry) => entry.definition.name)
  assert.deepEqual(names.sort(), ['codex_bridge_send', 'codex_bridge_status'])
  assert.equal(fake.skills.length, 1)
  assert.equal(fake.skills[0].name, 'codex-bridge')
  assert.ok(fake.skills[0].content.includes('codex_bridge_send'))
  assert.equal(typeof fake.skills[0].source, 'string')
  assert.ok(fake.skills[0].source.endsWith('SKILL.md'))

  const send = fake.tools.find((entry) => entry.definition.name === 'codex_bridge_send')
  assert.equal(typeof send.definition.execute, 'function')
  assert.equal(typeof send.definition.output.render, 'function')
  assert.equal(send.options.when({ agent: { id: SESSION_ID } }), true)
  assert.equal(send.options.when({ agent: { id: 'other-session' } }), false)

  const status = fake.tools.find((entry) => entry.definition.name === 'codex_bridge_status')
  const snapshot = await status.definition.execute({}, {})
  assert.equal(snapshot.instance.ready, false)
  assert.ok(snapshot.instance.reasons.some((reason) => reason.code === 'codex:not-ready'))

  fake.disposeAll()
  assert.equal(fake.skills[0].disposed, true)
  assert.equal(fake.tools[0].definition.disposed, true)
})

test('the send tool reports not-ready while the Codex probe has not succeeded', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const config = baseConfig(workspace, {
    codexExecutable: path.join(workspace.base, 'missing-codex.exe'),
  })
  const bridge = apply(fake.ctx, config)
  await bridge.start()
  t.after(() => bridge.stop())

  const send = fake.tools.find((entry) => entry.definition.name === 'codex_bridge_send')
  const result = await send.definition.execute({ text: 'hello' }, {})
  assert.equal(result.status, 'error')
  assert.equal(result.code, 'not-ready')
  assert.equal((await readRecords(workspace.root, FILES.inboxCodex)).records.length, 0)
})

test('applying with an incomplete config does not throw and reports why', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const bridge = apply(fake.ctx, { root: workspace.root })
  await bridge.start()
  t.after(() => bridge.stop())

  const status = fake.tools.find((entry) => entry.definition.name === 'codex_bridge_status')
  const snapshot = await status.definition.execute({}, {})
  assert.equal(snapshot.instance.ready, false)
  assert.ok(snapshot.instance.reasons.length > 0)
  const sent = await fake.tools
    .find((entry) => entry.definition.name === 'codex_bridge_send')
    .definition.execute({ text: 'x' }, {})
  assert.equal(sent.status, 'error')
})

test('webhook delivery defaults to followup so a running turn is not interrupted', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const config = baseConfig(workspace)
  const bridge = apply(fake.ctx, config)
  await bridge.start()
  t.after(() => bridge.stop())

  const message = makeMessage({ from: 'codex', to: 'dsh', text: 'from codex' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, message)
  await settleDelivery(bridge, fake)

  assert.equal(fake.steers.length, 0)
  assert.equal(fake.followups.length, 1)
  assert.equal(fake.prompts.length, 0)
  const delivered = fake.followups[0]
  assert.equal(delivered.sessionId, SESSION_ID)
  assert.equal(delivered.message.source.kind, 'webhook')
  assert.equal(delivered.message.source.deliveryId, message.id)
  assert.equal(delivered.message.role, 'user')
  assert.match(delivered.message.content[0].text, /\[codex-bridge\]\nid: /)
  assert.match(delivered.message.content[0].text, /route: default/)

  // Re-running the tick must not deliver the same message twice: the ledger
  // and the advanced cursor both guard the replay.
  await bridge.tick('test-again')
  assert.equal(fake.followups.length, 1)
})

test('deliveryMode steer delivers immediately instead of queueing for the next turn', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const config = baseConfig(workspace, { deliveryMode: 'steer' })
  const bridge = apply(fake.ctx, config)
  await bridge.start()
  t.after(() => bridge.stop())

  const message = makeMessage({ from: 'codex', to: 'dsh', text: 'urgent' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, message)
  await settleDelivery(bridge, fake)

  assert.equal(fake.steers.length, 1)
  assert.equal(fake.followups.length, 0)
  assert.equal(fake.steers[0].message.source.deliveryId, message.id)
})

test('user delivery mode keeps the durable request id', async (t) => {
  const workspace = await makeWorkspace(t)
  const fake = fakeContext()
  const config = baseConfig(workspace, { deliverySource: 'user' })
  const bridge = apply(fake.ctx, config)
  await bridge.start()
  t.after(() => bridge.stop())

  const message = makeMessage({ from: 'codex', to: 'dsh', text: 'from codex' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, message)
  await settleDelivery(bridge, fake)

  assert.equal(fake.steers.length, 0)
  assert.equal(fake.followups.length, 0)
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].requestId, `codex-bridge:${message.id}`)
  assert.equal(fake.prompts[0].sessionId, SESSION_ID)
  assert.equal(fake.prompts[0].mode, 'queue')
  assert.equal(fake.prompts[0].clientTimeZone, 'Asia/Shanghai')
  assert.match(fake.prompts[0].content[0].text, /\[codex-bridge\]\nid: /)
})
