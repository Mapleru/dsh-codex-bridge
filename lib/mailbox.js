import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const FILES = Object.freeze({
  inboxDsh: 'inbox-dsh.jsonl',
  inboxCodex: 'inbox-codex.jsonl',
  cursorDsh: 'cursor-dsh',
  cursorCodex: 'cursor-codex',
  state: 'state.json',
  lock: 'instance.lock',
  processing: 'processing.json',
  parked: 'parked.jsonl',
  events: 'events.jsonl',
  stop: 'STOP',
  session: 'session.json',
  routes: 'routes.json',
  delivered: 'delivered.jsonl',
  appendLock: '.append.lock',
  repliesDir: 'replies',
  outDir: 'out',
  archiveDir: 'archive',
  toolsDir: 'tools',
})

export const LIMITS = Object.freeze({
  readChunkBytes: 256 * 1024,
  readMaxLines: 50,
  scanChunkBytes: 256 * 1024,
  parkedMaxBytes: 4 * 1024 * 1024,
  eventsMaxBytes: 2 * 1024 * 1024,
  appendLockTimeoutMs: 5000,
})

export class MailboxError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MailboxError'
    this.code = code
    this.details = details
  }
}

export function isMailboxError(error) {
  return error instanceof MailboxError
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function pathExists(file) {
  try {
    await fsp.stat(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

/**
 * Write a small file through a same-directory temp file, fsync and rename, so
 * a crash leaves either the old or the new content, never a torn file.
 */
export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  let handle
  try {
    handle = await fsp.open(tmp, 'wx', 0o600)
    await handle.writeFile(data)
    try {
      await handle.sync()
    } catch {
      /* fsync is not supported on every filesystem; the rename still applies */
    }
    await handle.close()
    handle = undefined
    await fsp.rename(tmp, file)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fsp.unlink(tmp).catch(() => {})
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJsonFile(file, fallback = undefined) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function readTextBounded(file, maxBytes) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '', size: 0, truncated: false }
    throw error
  }
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: stat.size, truncated: stat.size > bytesRead }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function readCursor(root, name) {
  const raw = await fsp.readFile(path.join(root, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return 0
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export async function writeCursor(root, name, offset) {
  const value = Number.isInteger(offset) && offset >= 0 ? offset : 0
  await writeFileAtomic(path.join(root, name), `${value}\n`)
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/* ------------------------------------------------------------------ */
/* Append lock: one writer at a time across processes and within one   */
/* process. The lock file carries pid + token so a dead owner can be   */
/* reclaimed and a late release cannot delete someone else's lock.     */
/* ------------------------------------------------------------------ */

const chains = new Map()

function serialize(key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => {},
    () => {},
  )
  chains.set(key, tail)
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

async function acquireAppendLock(lockPath, { timeoutMs = LIMITS.appendLockTimeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs
  const token = crypto.randomBytes(12).toString('hex')
  let delay = 10
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))
        try {
          await handle.sync()
        } catch {
          /* best effort */
        }
      } finally {
        await handle.close()
      }
      return token
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new MailboxError('append-lock-failed', `cannot create append lock: ${error.code}`, { code: error.code })
      }
    }

    const info = await readJsonFile(lockPath, null)
    const stat = await fsp.stat(lockPath).catch(() => null)
    const age = stat ? Date.now() - stat.mtimeMs : 0
    const ownerDead = Boolean(info) && Number.isInteger(info.pid) && !isProcessAlive(info.pid)
    const unreadableAndOld = !info && age > 3000
    if (ownerDead || unreadableAndOld) {
      const stale = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      try {
        await fsp.rename(lockPath, stale)
        await fsp.unlink(stale).catch(() => {})
      } catch {
        /* raced with another process; retry */
      }
      continue
    }

    if (Date.now() >= deadline) {
      throw new MailboxError('append-lock-timeout', 'another writer holds the append lock', {
        ownerPid: info?.pid ?? null,
      })
    }
    await sleep(delay + Math.floor(Math.random() * 10))
    delay = Math.min(delay * 2, 100)
  }
}

async function releaseAppendLock(lockPath, token) {
  const info = await readJsonFile(lockPath, null)
  if (!info || info.token !== token) return
  await fsp.unlink(lockPath).catch(() => {})
}

export function withAppendLock(root, task, options) {
  const lockPath = path.join(root, FILES.appendLock)
  return serialize(lockPath, async () => {
    const token = await acquireAppendLock(lockPath, options)
    try {
      return await task()
    } finally {
      await releaseAppendLock(lockPath, token)
    }
  })
}

/* ------------------------------------------------------------------ */
/* Mailbox append, rotation and bounded reads                          */
/* ------------------------------------------------------------------ */

async function pruneArchive(root, file, maxBytes) {
  const dir = path.join(root, FILES.archiveDir)
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const candidates = []
  for (const name of names) {
    if (!name.startsWith(`${file}.`)) continue
    const full = path.join(dir, name)
    const stat = await fsp.stat(full).catch(() => null)
    if (stat) candidates.push({ full, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = candidates.reduce((sum, item) => sum + item.size, 0)
  const maxTotal = Math.max(maxBytes * 4, 1024 * 1024)
  while (candidates.length > 4 || total > maxTotal) {
    const oldest = candidates.shift()
    if (!oldest) break
    total -= oldest.size
    await fsp.unlink(oldest.full).catch(() => {})
  }
}

async function rotateLocked(root, file, cursorFile, maxBytes) {
  const target = path.join(root, file)
  const size = await fileSize(target)
  if (size === 0) return
  const cursor = cursorFile ? await readCursor(root, cursorFile) : size
  if (cursor < size) {
    throw new MailboxError('mailbox-full', 'mailbox reached its size limit and still has unconsumed records', {
      file,
      size,
      cursor,
    })
  }
  const dir = path.join(root, FILES.archiveDir)
  await fsp.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = path.join(dir, `${file}.${stamp}`)
  let suffix = 0
  while (await pathExists(dest)) {
    suffix += 1
    dest = path.join(dir, `${file}.${stamp}-${suffix}`)
  }
  await fsp.rename(target, dest)
  if (cursorFile) await writeCursor(root, cursorFile, 0)
  await pruneArchive(root, file, maxBytes)
}

/**
 * Force a rotation when the caller has decided the file is full. With no
 * cursor the whole file is considered consumed (used for parked.jsonl and
 * other diagnostic logs). Returns false for a missing/empty file.
 */
export async function rotateMailbox(root, file, options = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  return withAppendLock(
    root,
    async () => {
      const size = await fileSize(path.join(root, file))
      if (size === 0) return false
      await rotateLocked(root, file, options.cursorFile ?? null, maxBytes)
      return true
    },
    options,
  )
}

/**
 * Append exactly one JSON line. Full mailboxes either rotate (all existing
 * records were consumed) or fail with mailbox-full, which the caller surfaces
 * as busy; records are never silently dropped.
 */
export async function appendJsonLine(root, file, value, options = {}) {
  const line = `${JSON.stringify(value)}\n`
  const buffer = Buffer.from(line, 'utf8')
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const target = path.join(root, file)

  return withAppendLock(
    root,
    async () => {
      let size = await fileSize(target)
      if (size > 0 && size + buffer.length > maxBytes) {
        if (!options.cursorFile) {
          throw new MailboxError('mailbox-full', 'mailbox reached its size limit', { file, size })
        }
        await rotateLocked(root, file, options.cursorFile, maxBytes)
        size = 0
      }
      await fsp.mkdir(root, { recursive: true })
      const handle = await fsp.open(target, 'a', 0o600)
      try {
        await handle.write(buffer)
        try {
          await handle.sync()
        } catch {
          /* best effort */
        }
      } finally {
        await handle.close()
      }
      return { file, bytes: buffer.length, size: size + buffer.length }
    },
    options,
  )
}

/**
 * Read complete newline-terminated records starting at `cursor`.
 * A trailing partial line is left for a later call. `nextCursor` is the byte
 * offset just after the last returned record.
 */
export async function readBatch(root, file, cursor, options = {}) {
  const maxBytes = options.maxBytes ?? LIMITS.readChunkBytes
  const maxLines = options.maxLines ?? LIMITS.readMaxLines
  const target = path.join(root, file)
  let handle
  try {
    handle = await fsp.open(target, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], nextCursor: cursor, size: 0, reset: false, overflow: false }
    throw error
  }
  try {
    const { size } = await handle.stat()
    let start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
    let reset = false
    if (start > size) {
      start = 0
      reset = true
    }
    if (start >= size) return { lines: [], nextCursor: start, size, reset, overflow: false }

    const toRead = Math.min(size - start, maxBytes)
    const buffer = Buffer.allocUnsafe(toRead)
    const { bytesRead } = await handle.read(buffer, 0, toRead, start)
    const chunk = buffer.subarray(0, bytesRead)
    const lines = []
    let position = 0
    let nextCursor = start
    while (lines.length < maxLines) {
      const newline = chunk.indexOf(0x0a, position)
      if (newline === -1) break
      let raw = chunk.subarray(position, newline).toString('utf8')
      if (start === 0 && position === 0 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
      lines.push({ raw, end: start + newline + 1 })
      nextCursor = start + newline + 1
      position = newline + 1
    }
    const overflow = lines.length === 0 && bytesRead === maxBytes && start + bytesRead < size
    return { lines, nextCursor, size, reset, overflow }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Find the byte offset after the next newline, used to skip a single record
 * that is too large for the normal read window.
 */
export async function skipToNextNewline(root, file, from, options = {}) {
  const maxScanBytes = options.maxScanBytes ?? 16 * 1024 * 1024
  const chunkBytes = options.chunkBytes ?? LIMITS.scanChunkBytes
  const target = path.join(root, file)
  let handle
  try {
    handle = await fsp.open(target, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return from
    throw error
  }
  try {
    const { size } = await handle.stat()
    let position = Math.max(0, Math.min(from, size))
    const stop = Math.min(size, position + maxScanBytes)
    const buffer = Buffer.allocUnsafe(chunkBytes)
    while (position < stop) {
      const length = Math.min(chunkBytes, stop - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (!bytesRead) break
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      if (newline !== -1) return position + newline + 1
      position += bytesRead
    }
    return position
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Count complete pending records without loading their bodies into memory. */
export async function countPendingLines(root, file, cursor, options = {}) {
  const limit = options.limit ?? 10000
  const chunkBytes = options.chunkBytes ?? 65536
  const target = path.join(root, file)
  let handle
  try {
    handle = await fsp.open(target, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  try {
    const { size } = await handle.stat()
    let position = Number.isInteger(cursor) && cursor >= 0 && cursor <= size ? cursor : 0
    let count = 0
    const buffer = Buffer.allocUnsafe(chunkBytes)
    while (position < size && count <= limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, size - position), position)
      if (!bytesRead) break
      const slice = buffer.subarray(0, bytesRead)
      let index = slice.indexOf(0x0a)
      while (index !== -1) {
        count += 1
        if (count > limit) break
        index = slice.indexOf(0x0a, index + 1)
      }
      position += bytesRead
    }
    return count
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function readRecords(root, file, options = {}) {
  const maxBytes = options.maxBytes ?? LIMITS.parkedMaxBytes
  const { text, truncated } = await readTextBounded(path.join(root, file), maxBytes)
  const records = []
  let invalid = 0
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      records.push(JSON.parse(raw))
    } catch {
      invalid += 1
    }
  }
  return { records, invalid, truncated }
}

const messageCache = new Map()
const MESSAGE_CACHE_LIMIT = 256

function cacheMessage(root, message) {
  if (!message || typeof message.id !== 'string') return
  const key = `${root}\u0000${message.id}`
  if (messageCache.size >= MESSAGE_CACHE_LIMIT) {
    const oldest = messageCache.keys().next().value
    if (oldest !== undefined) messageCache.delete(oldest)
  }
  messageCache.set(key, message)
}

function scanForMessage(text, id, parked = false) {
  for (const raw of text.split('\n')) {
    if (!raw) continue
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (parked) {
      if (value?.message?.id === id) return value.message
    } else if (value?.id === id) {
      return value
    }
  }
  return null
}

/**
 * Locate a message by id across both inboxes and parked.jsonl. Positive
 * results are cached; negative results are not, because a parent may be
 * appended concurrently.
 */
export async function findMessage(root, id, options = {}) {
  if (typeof id !== 'string' || !id) return null
  const key = `${root}\u0000${id}`
  const cached = messageCache.get(key)
  if (cached) return cached
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  for (const file of [FILES.inboxDsh, FILES.inboxCodex]) {
    const { text } = await readTextBounded(path.join(root, file), maxBytes)
    const found = scanForMessage(text, id)
    if (found) {
      cacheMessage(root, found)
      return found
    }
  }
  const { text } = await readTextBounded(path.join(root, FILES.parked), LIMITS.parkedMaxBytes)
  const parked = scanForMessage(text, id, true)
  if (parked) cacheMessage(root, parked)
  return parked
}

/** Find the reply already appended for a parent message, if any. */
export async function findReplyTo(root, parentId, options = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const { text } = await readTextBounded(path.join(root, FILES.inboxDsh), maxBytes)
  for (const raw of text.split('\n')) {
    if (!raw) continue
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (value?.from === 'codex' && value?.replyTo === parentId && typeof value?.id === 'string') return value
  }
  return null
}

export async function appendEvent(root, event, options = {}) {
  const maxBytes = options.maxBytes ?? LIMITS.eventsMaxBytes
  const line = `${JSON.stringify(event)}\n`
  const target = path.join(root, FILES.events)
  return withAppendLock(
    root,
    async () => {
      const size = await fileSize(target)
      if (size > 0 && size + Buffer.byteLength(line, 'utf8') > maxBytes) {
        const previous = path.join(root, 'events.1.jsonl')
        await fsp.rm(previous, { force: true }).catch(() => {})
        await fsp.rename(target, previous).catch(() => {})
      }
      await fsp.mkdir(root, { recursive: true })
      const handle = await fsp.open(target, 'a', 0o600)
      try {
        await handle.write(line)
      } finally {
        await handle.close()
      }
    },
    options,
  )
}

/* ------------------------------------------------------------------ */
/* Instance lock                                                       */
/* ------------------------------------------------------------------ */

/**
 * Exclusive create of instance.lock. A live pid keeps the lock; a lock whose
 * pid is provably dead (or that is unreadable for more than 3 s) can be
 * reclaimed. Age alone never proves the owner is gone.
 */
export async function acquireInstanceLock(root, owner, options = {}) {
  const attempts = options.attempts ?? 2
  const lockPath = path.join(root, FILES.lock)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(owner, null, 2))
        try {
          await handle.sync()
        } catch {
          /* best effort */
        }
      } finally {
        await handle.close()
      }
      return { acquired: true, owner }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = await readJsonFile(lockPath, null)
      const stat = await fsp.stat(lockPath).catch(() => null)
      const age = stat ? Date.now() - stat.mtimeMs : 0
      if (info && info.pid === process.pid) return { acquired: false, owner: info, reason: 'same-process' }
      if (info && Number.isInteger(info.pid) && isProcessAlive(info.pid)) return { acquired: false, owner: info, reason: 'pid-alive' }
      if (!info && age < 3000) return { acquired: false, owner: null, reason: 'unreadable-recent' }
      const stale = `${lockPath}.stale-${process.pid}-${Date.now()}`
      try {
        await fsp.rename(lockPath, stale)
        await fsp.unlink(stale).catch(() => {})
      } catch {
        return { acquired: false, owner: info, reason: 'race' }
      }
    }
  }
  return { acquired: false, owner: await readJsonFile(lockPath, null), reason: 'race' }
}

export async function releaseInstanceLock(root, instanceId) {
  const lockPath = path.join(root, FILES.lock)
  const info = await readJsonFile(lockPath, null)
  if (!info || info.instanceId !== instanceId || info.pid !== process.pid) return false
  await fsp.unlink(lockPath).catch(() => {})
  return true
}

export async function readInstanceLock(root) {
  return readJsonFile(path.join(root, FILES.lock), null)
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Create the mailbox skeleton. Missing cursor files mean offset 0. */
export async function ensureLayout(root) {
  await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(path.join(root, FILES.repliesDir), { recursive: true })
  await fsp.mkdir(path.join(root, FILES.outDir), { recursive: true })
  await fsp.mkdir(path.join(root, FILES.archiveDir), { recursive: true })
  for (const file of [FILES.inboxDsh, FILES.inboxCodex]) {
    const handle = await fsp.open(path.join(root, file), 'a', 0o600)
    await handle.close()
  }
  for (const cursor of [FILES.cursorDsh, FILES.cursorCodex]) {
    const target = path.join(root, cursor)
    if (!(await pathExists(target))) await writeCursor(root, cursor, 0)
  }
}
