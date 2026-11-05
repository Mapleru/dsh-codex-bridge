#!/usr/bin/env node
/**
 * codex-bridge control — operator entry point.
 *
 *   node tools/ctl.mjs status
 *   node tools/ctl.mjs stop
 *   node tools/ctl.mjs resume
 *   node tools/ctl.mjs parked [--json]
 *   node tools/ctl.mjs retry <message-id> [--confirm-uncertain]
 *   node tools/ctl.mjs retry --all --confirm-uncertain
 *
 * `retry` never calls Codex itself: it removes the parked record and rewinds
 * cursor-codex so the bridge re-reads the original message on its next tick.
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// This file runs from the package (`tools/ctl.mjs` -> `../lib/`) and from a
// copy inside the mailbox (`<root>/tools/ctl.mjs` -> `./lib/`).
async function loadMailbox() {
  try {
    return await import('../lib/mailbox.js')
  } catch {
    return await import('./lib/mailbox.js')
  }
}

const {
  ensureLayout,
  FILES,
  pathExists,
  readJsonFile,
  readRecords,
  writeCursor,
  writeFileAtomic,
  writeJsonAtomic,
} = await loadMailbox()

function usage(code = 0) {
  process.stdout.write(
    [
      'Usage: node tools/ctl.mjs <command> [options]',
      '',
      'Commands:',
      '  status                        Print state.json.',
      '  stop                          Create STOP (no new deliveries or Codex calls).',
      '  resume                        Remove STOP.',
      '  parked [--json]               List parked records.',
      '  reset-session [route]         Forget a route\'s Codex session id (default route when omitted).',
      '  bind <route> <session-id>     Pin a route to an existing Codex thread id.',
      '  routes [--json]               Print routes.json (per-route bindings).',
      '  receipt <message-id>          Show the reply produced for a message.',
      '  retry <message-id> [--confirm-uncertain]',
      '  retry --all --confirm-uncertain',
      '',
      'Options:',
      '  --root <path>                 Mailbox root (default: parent of tools/).',
    ].join('\n') + '\n',
  )
  process.exit(code)
}

const argv = process.argv.slice(2)
let root = path.resolve(HERE, '..')
let rootGiven = false
const rest = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--root') {
    root = path.resolve(argv[++i])
    rootGiven = true
  } else if (argv[i] === '--help' || argv[i] === '-h') usage(0)
  else rest.push(argv[i])
}

const command = rest[0]
if (!command) usage(3)

// Never create a mailbox by accident: running this file from the package
// directory without --root used to fabricate an empty layout and then report
// "0 parked", which reads as a truthful answer.
if (!(await pathExists(path.join(root, FILES.state))) && !(await pathExists(path.join(root, FILES.inboxCodex)))) {
  process.stderr.write(`mailbox not found at ${root}${rootGiven ? '' : '; pass --root <mailbox>'}
`)
  process.exit(4)
}

await ensureLayout(root)

if (command === 'status') {
  const state = await readJsonFile(path.join(root, FILES.state), null)
  if (!state) {
    process.stderr.write('state.json not found; the bridge has not run yet\n')
    process.exit(4)
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
  process.exit(0)
}

if (command === 'stop') {
  await writeFileAtomic(path.join(root, FILES.stop), `${new Date().toISOString()}\n`)
  process.stdout.write('STOP created; new deliveries and Codex calls are paused\n')
  process.exit(0)
}

if (command === 'resume') {
  const file = path.join(root, FILES.stop)
  if (await pathExists(file)) {
    const fs = await import('node:fs/promises')
    await fs.unlink(file)
    process.stdout.write('STOP removed; pending work resumes\n')
  } else {
    process.stdout.write('STOP was not present\n')
  }
  process.exit(0)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadRoutes() {
  const store = await readJsonFile(path.join(root, FILES.routes), null)
  if (store && typeof store === 'object' && store.routes && typeof store.routes === 'object') return store
  return { version: 1, routes: {} }
}

async function saveRoutes(store) {
  await writeJsonAtomic(path.join(root, FILES.routes), store)
}

if (command === 'receipt') {
  const id = rest[1]
  if (!id) {
    process.stderr.write('receipt needs a message id\n')
    process.exit(3)
  }
  const fs = await import('node:fs/promises')
  const outbound = (await readRecords(root, FILES.inboxCodex, { maxBytes: 8 * 1024 * 1024 })).records.find(
    (record) => record.replyTo === id,
  )
  let entries = []
  try {
    entries = await fs.readdir(path.join(root, FILES.repliesDir))
  } catch {
    entries = []
  }
  const acks = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const record = await readJsonFile(path.join(root, FILES.repliesDir, name), null)
    if (!record) continue
    if (record.replyTo === id || record.messageId === id) acks.push(record)
    else if (outbound && record.replyTo === outbound.id) acks.push(record)
  }
  if (!outbound && acks.length === 0) {
    process.stderr.write('no reply recorded for that message yet\n')
    process.exit(4)
  }
  if (outbound) {
    process.stdout.write(
      JSON.stringify({
        direction: 'dsh-to-codex',
        id: outbound.id,
        at: outbound.at,
        route: outbound.route ?? null,
        hops: outbound.hops ?? null,
        replyTo: outbound.replyTo ?? null,
        chars: typeof outbound.text === 'string' ? outbound.text.length : 0,
      }) + '\n' + String(outbound.text ?? '').trim() + '\n',
    )
  }
  for (const record of acks) {
    let text = ''
    try {
      text = await fs.readFile(path.join(root, FILES.repliesDir, record.messageId + '.txt'), 'utf8')
    } catch {
      text = ''
    }
    process.stdout.write(
      JSON.stringify({
        direction: 'codex-to-dsh',
        messageId: record.messageId,
        replyId: record.replyId,
        replyTo: record.replyTo,
        route: record.route ?? null,
        hops: record.hops ?? null,
        status: record.status,
        savedAt: record.savedAt,
        appendedAt: record.appendedAt ?? null,
        codexSessionId: record.codexSessionId ?? null,
        chars: text.length,
      }) + '\n' + text.trim() + '\n',
    )
  }
  process.exit(0)
}

if (command === 'routes') {
  const store = await loadRoutes()
  process.stdout.write(`${JSON.stringify(store, null, 2)}\n`)
  process.exit(0)
}

if (command === 'bind') {
  const routeId = rest[1]
  const sessionId = rest[2]
  if (!routeId || !sessionId) usage(3)
  if (!UUID_RE.test(sessionId)) {
    process.stderr.write('session id must be a UUID\n')
    process.exit(3)
  }
  const store = await loadRoutes()
  const route = store.routes[routeId] ?? {}
  store.routes[routeId] = {
    ...route,
    codexSessionId: sessionId,
    sessionLost: false,
    sessionIdUnavailable: false,
    updatedAt: new Date().toISOString(),
  }
  // A fresh bind clears a previous loss marker; otherwise the bridge would
  // refuse to call the newly bound thread at all.
  delete store.routes[routeId].lostAt
  delete store.routes[routeId].unavailableAt
  delete store.routes[routeId].previousSessionId
  delete store.routes[routeId].code
  delete store.routes[routeId].lastErrorCode
  await saveRoutes(store)
  if (routeId === 'default') {
    // Keep the legacy mirror in sync, otherwise the bridge's adoption path
    // would treat the old mirror as newer and undo this bind.
    await writeJsonAtomic(path.join(root, FILES.session), {
      sessionId,
      updatedAt: store.routes[routeId].updatedAt,
    })
  }
  process.stdout.write(`route ${routeId} now reuses Codex thread ${sessionId}\n`)
  process.exit(0)
}

if (command === 'reset-session') {
  const routeIndex = rest.indexOf('--route')
  const routeId = (routeIndex >= 0 ? rest[routeIndex + 1] : rest[1]) || 'default'
  const store = await loadRoutes()
  store.routes[routeId] = {
    ...(store.routes[routeId] ?? {}),
    codexSessionId: null,
    sessionLost: false,
    sessionIdUnavailable: false,
    updatedAt: new Date().toISOString(),
  }
  await saveRoutes(store)
  if (routeId === 'default') {
    await writeJsonAtomic(path.join(root, FILES.session), {
      sessionId: null,
      resetAt: new Date().toISOString(),
    })
  }
  process.stdout.write(`route ${routeId} reset; the next Codex call on it starts a new thread\n`)
  process.exit(0)
}

if (command === 'parked') {
  const { records, invalid } = await readRecords(root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
  if (rest.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ records, invalid }, null, 2)}\n`)
    process.exit(0)
  }
  process.stdout.write(`parked: ${records.length} record(s), invalid lines: ${invalid}\n`)
  for (const record of records) {
    process.stdout.write(
      `${record.at ?? '-'}  ${record.code ?? 'unknown'}  ${record.messageId ?? '-'}  hops=${record.hops ?? '-'}\n`,
    )
  }
  process.exit(0)
}

if (command === 'retry') {
  const confirmUncertain = rest.includes('--confirm-uncertain')
  const all = rest.includes('--all')
  const id = rest[1] && !rest[1].startsWith('--') ? rest[1] : null
  if (!all && !id) usage(3)

/** Byte offset of the inbox-codex line whose JSON `id` matches. */
async function lineStartForMessage(root, messageId) {
  const fs = await import('node:fs/promises')
  let buf
  try {
    buf = await fs.readFile(path.join(root, FILES.inboxCodex))
  } catch {
    return null
  }
  let offset = 0
  while (offset < buf.length) {
    const end = buf.indexOf(0x0a, offset)
    if (end === -1) break
    try {
      if (JSON.parse(buf.subarray(offset, end).toString('utf8')).id === messageId) return offset
    } catch {
      // ignore malformed lines; the bridge parks them separately
    }
    offset = end + 1
  }
  return null
}

  const { records } = await readRecords(root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
  const targets = records.filter((record) => (all ? true : record.messageId === id))
  if (targets.length === 0) {
    process.stderr.write('no matching parked record\n')
    process.exit(4)
  }
  const uncertain = targets.filter((record) => record.code === 'delivery-uncertain')
  if (uncertain.length > 0 && !confirmUncertain) {
    process.stderr.write(
      'refusing to retry delivery-uncertain records without --confirm-uncertain ' +
        '(the external call may already have had side effects)\n',
    )
    process.exit(3)
  }

  const keep = records.filter((record) => !targets.includes(record))
  const body = keep.map((record) => `${JSON.stringify(record)}\n`).join('')
  await writeFileAtomic(path.join(root, FILES.parked), body)
  const archive = path.join(root, FILES.archiveDir, `retry-${Date.now()}.jsonl`)
  await writeFileAtomic(archive, targets.map((record) => `${JSON.stringify(record)}\n`).join(''))

  let rewind = null
  for (const record of targets) {
    // `cursorAfter` is the end of the message line; rewinding there skips the
    // message. Prefer the start offset of the line that carries this id.
    const start = await lineStartForMessage(root, record.messageId)
    const candidate = start ?? record.cursorAfter
    if (Number.isInteger(candidate) && (rewind === null || candidate < rewind)) {
      rewind = candidate
    }
  }
  if (rewind !== null) await writeCursor(root, FILES.cursorCodex, rewind)

  const processing = await readJsonFile(path.join(root, FILES.processing), null)
  if (processing && targets.some((record) => record.messageId === processing.messageId)) {
    const fs = await import('node:fs/promises')
    await fs.unlink(path.join(root, FILES.processing)).catch(() => {})
  }

  process.stdout.write(
    `retried ${targets.length} record(s); cursor-codex=${rewind ?? 'unchanged'}; archived to ${path.relative(root, archive)}\n`,
  )
  process.exit(0)
}

usage(3)
