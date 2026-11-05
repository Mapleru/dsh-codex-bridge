#!/usr/bin/env node
/**
 * codex-bridge sender — run on the Codex side.
 *
 *   node tools/send.mjs --to dsh --file <body.txt> [--reply-to <message-id>]
 *   printf 'text' | node tools/send.mjs --to dsh
 *
 * The body never goes through the command line; use --file or stdin.
 * This file is copied into <root>/tools/ by the plugin and imports its own
 * copy of the shared mailbox/protocol modules from <root>/tools/lib/.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function loadLib(name) {
  try {
    return await import(new URL(`../lib/${name}`, import.meta.url))
  } catch {
    return await import(new URL(`./lib/${name}`, import.meta.url))
  }
}

function usage(code = 0) {
  const text = [
    'Usage: node tools/send.mjs --to dsh (--file <path> | stdin) [options]',
    '',
    'Options:',
    '  --to dsh                 Required. Only the DSH mailbox is supported.',
    '  --file <path>            Read the body from a UTF-8 file (use - for stdin).',
    '  --reply-to <message-id>  Answer a known message; hops = parent hops + 1.',
    '  --route <route-id>       Target route; replies must match the parent route.',
    '  --root <path>            Mailbox root (default: parent of this tools/ dir).',
    '  --max-bytes <n>          Body limit (default 32768).',
    '  --help                   Show this help.',
    '',
    'Exit codes: 0 queued/duplicate, 2 busy, 3 rejected, 4 error.',
  ].join('\n')
  process.stdout.write(`${text}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { to: null, file: null, replyTo: null, route: null, root: null, maxBytes: 32768 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') usage(0)
    else if (arg === '--to') options.to = argv[++i]
    else if (arg === '--file') options.file = argv[++i]
    else if (arg === '--reply-to') options.replyTo = argv[++i]
    else if (arg === '--route') options.route = argv[++i]
    else if (arg === '--root') options.root = argv[++i]
    else if (arg === '--max-bytes') options.maxBytes = Number.parseInt(argv[++i], 10)
    else {
      process.stderr.write(`unknown argument: ${arg}\n`)
      usage(3)
    }
  }
  if (options.to !== 'dsh') {
    process.stderr.write('only --to dsh is supported\n')
    usage(3)
  }
  if (options.replyTo === '') options.replyTo = null
  if (options.route === '') options.route = null
  return options
}

async function readStdin() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > 16 * 1024 * 1024) throw new Error('stdin-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function fail(code, message, exitCode = 3) {
  process.stdout.write(`${JSON.stringify({ status: 'rejected', code, message })}\n`)
  process.exit(exitCode)
}

const options = parseArgs(process.argv.slice(2))
const { appendJsonLine, ensureLayout, FILES, findMessage, pathExists, readBatch, readCursor } = await loadLib('mailbox.js')
const { makeMessage, validateMessage, byteLength, ROUTE_ID_RE } = await loadLib('protocol.js')

const root = options.root
  ? path.resolve(options.root)
  : path.resolve(HERE, '..')

let body
try {
  if (options.file && options.file !== '-') {
    body = await fs.readFile(path.resolve(options.file), 'utf8')
  } else {
    body = await readStdin()
  }
} catch (error) {
  fail('body-read-failed', `cannot read the body: ${error.code ?? 'error'}`, 4)
}

const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
if (!text) fail('empty-body', 'the message body is empty')
if (byteLength(text) > options.maxBytes) fail('message-too-large', `body exceeds ${options.maxBytes} bytes`)

await ensureLayout(root)
if (await pathExists(path.join(root, FILES.stop))) fail('stop', 'STOP is present; the bridge is paused', 3)

let hops = 1
let parent = null
let route = options.route
if (route !== null && !ROUTE_ID_RE.test(route)) fail('invalid-route', 'route must match the route id format')
if (options.replyTo) {
  parent = await findMessage(root, options.replyTo)
  if (!parent) fail('reply-target-unknown', 'replyTo does not reference a known message')
  hops = (parent.hops ?? 1) + 1
  const parentRoute = parent.route ?? null
  if (route !== null && parentRoute !== null && route !== parentRoute) {
    fail('route-mismatch', `parent belongs to route "${parentRoute}"`)
  }
  route = parentRoute
}

// Content dedupe inside the still-pending window: a retried send with the same
// body and parent reuses the queued message instead of adding a duplicate.
const cursor = await readCursor(root, FILES.cursorDsh)
let offset = cursor
let existing = null
for (let page = 0; page < 20 && !existing; page += 1) {
  const batch = await readBatch(root, FILES.inboxDsh, offset, { maxBytes: 256 * 1024, maxLines: 50 })
  if (batch.lines.length === 0) break
  for (const line of batch.lines) {
    let parsed
    try {
      parsed = JSON.parse(line.raw)
    } catch {
      continue
    }
    const check = validateMessage(parsed, { from: 'codex', to: 'dsh', maxMessageBytes: options.maxBytes })
    if (!check.ok) continue
    if (
      check.message.text === text &&
      (check.message.replyTo ?? null) === (options.replyTo ?? null) &&
      (check.message.route ?? null) === (route ?? null)
    ) {
      existing = check.message
      break
    }
  }
  if (existing || batch.nextCursor >= batch.size) break
  offset = batch.nextCursor
}
if (existing) {
  process.stdout.write(`${JSON.stringify({ status: 'duplicate', id: existing.id, hops: existing.hops, route: existing.route ?? null })}\n`)
  process.exit(0)
}

const message = makeMessage({ from: 'codex', to: 'dsh', text, hops, replyTo: options.replyTo ?? null, route })

try {
  await appendJsonLine(root, FILES.inboxDsh, message, {
    maxBytes: 8 * 1024 * 1024,
    cursorFile: FILES.cursorDsh,
  })
} catch (error) {
  if (error?.code === 'mailbox-full') fail('busy', 'mailbox is full; retry later', 2)
  fail('append-failed', `cannot append the message: ${error?.code ?? 'error'}`, 4)
}

process.stdout.write(`${JSON.stringify({ status: 'queued', id: message.id, hops: message.hops, route: message.route ?? null })}\n`)
