import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { baseConfig, makeWorkspace, startBridge } from './helpers.mjs'
import { findRoute, normalizeConfig } from '../lib/config.js'
import { appendJsonLine, FILES, readJsonFile, readRecords, writeJsonAtomic } from '../lib/mailbox.js'
import { makeMessage } from '../lib/protocol.js'

const ALPHA_SESSION = '11111111-2222-4333-8444-555555555555'
const BETA_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const STRANGER_SESSION = '99999999-8888-4777-8666-555555555555'
const THREAD = '12121212-3434-4565-8787-909090909090'

function twoRoutes(workspace, overrides = {}) {
  return normalizeConfig({
    root: workspace.root,
    codexExecutable: baseConfig(workspace).codexExecutable,
    codexWorkingDirectory: workspace.cwd,
    pollIntervalMs: 250,
    retryBaseMs: 100,
    debounceMs: 0,
    maxAttempts: 2,
    routes: [
      { id: 'alpha', dshSessionId: ALPHA_SESSION },
      { id: 'beta', dshSessionId: BETA_SESSION },
    ],
    ...overrides,
  })
}

test('routes are normalized and the first route mirrors the legacy fields', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = twoRoutes(workspace)
  assert.equal(config.routes.length, 2)
  assert.equal(config.dshSessionId, ALPHA_SESSION)
  assert.equal(findRoute(config, 'beta').dshSessionId, BETA_SESSION)
  assert.equal(findRoute(config, 'missing'), null)
  assert.equal(findRoute(config, null, { fallbackSingle: false }), null)
})

test('send selects the route owned by the calling DSH session', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = twoRoutes(workspace)
  const { bridge } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const fromAlpha = await bridge.send('hello alpha', { caller: ALPHA_SESSION })
  assert.equal(fromAlpha.status, 'queued')
  assert.equal(fromAlpha.route, 'alpha')

  const fromBeta = await bridge.send('hello beta', { caller: BETA_SESSION })
  assert.equal(fromBeta.status, 'queued')
  assert.equal(fromBeta.route, 'beta')

  const forbidden = await bridge.send('hello stranger', { caller: STRANGER_SESSION })
  assert.equal(forbidden.status, 'error')
  assert.equal(forbidden.code, 'route-forbidden')
})

test('a Codex message without a route is parked when several routes exist', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = twoRoutes(workspace)
  const { bridge, delivered } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const ambiguous = makeMessage({ from: 'codex', to: 'dsh', text: 'who am i' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, ambiguous)
  await bridge.tick('test')
  assert.equal(delivered.length, 0)

  const records = await readRecords(workspace.root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
  assert.equal(records.records.at(-1).code, 'route-required')

  const routed = makeMessage({ from: 'codex', to: 'dsh', text: 'for beta', route: 'beta' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, routed)
  await bridge.tick('test')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].route, 'beta')
  assert.equal(delivered[0].id, routed.id)
})

test('an unknown route is parked and never delivered', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = twoRoutes(workspace)
  const { bridge, delivered } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const message = makeMessage({ from: 'codex', to: 'dsh', text: 'ghost', route: 'gamma' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, message)
  await bridge.tick('test')

  assert.equal(delivered.length, 0)
  const records = await readRecords(workspace.root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
  assert.equal(records.records.at(-1).code, 'route-unknown')
})

test('replies inherit the parent route and reject a contradictory one', async (t) => {
  const workspace = await makeWorkspace(t)
  const config = twoRoutes(workspace)
  const { bridge, delivered } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const parent = makeMessage({ from: 'codex', to: 'dsh', text: 'question', route: 'beta' })
  await appendJsonLine(workspace.root, FILES.inboxDsh, parent)
  await bridge.tick('test')
  assert.equal(delivered.length, 1)

  const inherited = await bridge.send('answer', { replyTo: parent.id, caller: BETA_SESSION })
  assert.equal(inherited.status, 'queued')
  assert.equal(inherited.route, 'beta')
  assert.equal(inherited.hops, 2)

  const contradiction = await bridge.send('answer', { replyTo: parent.id, route: 'alpha', caller: ALPHA_SESSION })
  assert.equal(contradiction.status, 'error')
  assert.equal(contradiction.code, 'route-mismatch')
})

test('a lost route is reported instead of starting a new thread', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeJsonAtomic(`${workspace.root}/${FILES.routes}`, {
    version: 1,
    routes: { beta: { codexSessionId: null, lostAt: new Date().toISOString() } },
  })
  const config = twoRoutes(workspace)
  const { bridge } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const result = await bridge.send('are you there', { caller: BETA_SESSION })
  assert.equal(result.status, 'error')
  assert.equal(result.code, 'route-session-lost')
  assert.equal(result.route, 'beta')
})

test('a legacy session.json binding migrates into the default route', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeJsonAtomic(`${workspace.root}/${FILES.session}`, { sessionId: THREAD })
  const config = baseConfig(workspace)
  const { bridge } = await startBridge(workspace, { config })
  t.after(() => bridge.stop())

  const store = await readJsonFile(`${workspace.root}/${FILES.routes}`, null)
  assert.equal(store.routes.default.codexSessionId, THREAD)
  assert.equal(bridge.snapshot().codex.sessionId, THREAD)
  assert.equal(bridge.snapshot().routes[0].codexSessionId, THREAD)
})

test('each route resumes its own Codex thread', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeJsonAtomic(`${workspace.root}/${FILES.routes}`, {
    version: 1,
    routes: { alpha: { codexSessionId: THREAD } },
  })
  const config = twoRoutes(workspace)
  const calls = []
  const runner = async (options) => {
    calls.push(options)
    const index = options.args.indexOf('resume')
    const sessionId = index >= 0 ? options.args[index + 1] : null
    return { ok: true, replyText: `reply-${sessionId ?? 'new'}`, sessionId: sessionId ?? crypto.randomUUID() }
  }
  const { bridge } = await startBridge(workspace, { config, runner })
  t.after(() => bridge.stop())

  await bridge.send('alpha turn', { caller: ALPHA_SESSION })
  await bridge.tick('alpha')
  await bridge.send('beta turn', { caller: BETA_SESSION })
  await bridge.tick('beta')

  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes('resume'))
  assert.ok(calls[0].args.includes(THREAD))
  assert.ok(!calls[1].args.includes('resume'))
  const snapshot = bridge.snapshot()
  const beta = snapshot.routes.find((route) => route.id === 'beta')
  assert.ok(beta.codexSessionId)
})

test('a newer route bind is not undone by an older legacy session.json', async (t) => {
  const workspace = await makeWorkspace(t)
  const calls = []
  const { bridge } = await startBridge(workspace, {
    runner: async (options) => {
      calls.push(options)
      return { ok: true, completed: true, replyText: 'ok', sessionId: THREAD }
    },
  })
  t.after(() => bridge.stop())

  const old = new Date(Date.now() - 60_000).toISOString()
  const now = new Date().toISOString()
  await writeJsonAtomic(`${workspace.root}/${FILES.session}`, {
    sessionId: '99999999-1111-4111-8111-111111111111',
    updatedAt: old,
  })
  await writeJsonAtomic(`${workspace.root}/${FILES.routes}`, {
    version: 1,
    routes: { default: { codexSessionId: THREAD, updatedAt: now } },
    updatedAt: now,
  })

  await bridge.tick('adopt-check')
  await bridge.send('one turn')
  await bridge.tick('run')

  const routes = await readJsonFile(`${workspace.root}/${FILES.routes}`, null)
  assert.equal(routes.routes.default.codexSessionId, THREAD)
  assert.ok(calls[0].args.includes('resume'))
  assert.equal(calls[0].args[calls[0].args.indexOf('resume') + 1], THREAD)
})
