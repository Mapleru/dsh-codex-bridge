import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Bridge } from '../lib/bridge.js'
import { normalizeConfig } from '../lib/config.js'

export const SESSION_ID = '11111111-2222-4333-8444-555555555555'

export async function makeWorkspace(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const cwd = path.join(base, 'collab')
  const root = path.join(cwd, 'mailbox')
  await fs.mkdir(cwd, { recursive: true })
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  })
  return { base, cwd, root }
}

export function baseConfig(workspace, overrides = {}) {
  return normalizeConfig({
    root: workspace.root,
    dshSessionId: SESSION_ID,
    codexExecutable: path.join(workspace.base, 'codex.exe'),
    codexWorkingDirectory: workspace.cwd,
    pollIntervalMs: 250,
    retryBaseMs: 100,
    debounceMs: 0,
    maxAttempts: 2,
    ...overrides,
  })
}

export const okProbeCodex = async () => ({
  ok: true,
  version: 'codex-cli 0.0.0-test',
  capabilities: { noDaemon: true, exec: true, resume: true, json: true, outputLastMessage: true, skipGitRepoCheck: true, sandbox: true },
  missing: [],
})

export const okProbeSession = async () => ({ ok: true })

export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export function makeBridge(workspace, options = {}) {
  const config = options.config ?? baseConfig(workspace, options.overrides)
  const delivered = []
  const bridge = new Bridge({
    config,
    deliver: async (message) => {
      delivered.push(message)
      const result = options.deliver ? await options.deliver(message) : { accepted: true }
      return result
    },
    probeSession: options.probeSession ?? okProbeSession,
    probeCodex: options.probeCodex ?? okProbeCodex,
    runner: options.runner ?? (async () => ({ ok: true, replyText: 'default reply', sessionId: crypto.randomUUID() })),
    queueRunner: options.queueRunner,
    codexHome: options.codexHome,
    watch: options.watch ?? false,
    autoTick: options.autoTick ?? false,
    logger: options.logger ?? { info() {}, warn() {}, error() {} },
    helperSource: options.helperSource ?? null,
    now: options.now,
  })
  return { bridge, delivered, config }
}

export async function startBridge(workspace, options = {}) {
  const made = makeBridge(workspace, options)
  await made.bridge.start()
  return made
}

export function replyOf(delivered, index = 0) {
  return delivered[index]
}
