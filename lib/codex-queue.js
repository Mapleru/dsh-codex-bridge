import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Queue transport: hand a message to a Codex thread that another process owns
 * (the desktop app keeps an exclusive writer, so `exec resume` is refused with
 * "already has an active writer"). `codex queue` goes through the shared
 * app-server and appends a turn; the answer is read back from the thread's
 * rollout JSONL because the queue command itself returns no text.
 */

export const QUEUE_POLL_MS = 500

export function codexHomeFromEnv(env = process.env) {
  const configured = env?.CODEX_HOME?.trim()
  return configured || path.join(os.homedir(), '.codex')
}

/**
 * Rollout files live at <home>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<thread>.jsonl.
 * Newer Codex builds may also archive them under <home>/archived_sessions.
 */
export async function findRollout(codexHome, threadId) {
  if (!threadId) return null
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')]
  let best = null
  for (const root of roots) {
    let entries
    try {
      entries = await fsp.readdir(root, { recursive: true, withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || !name.includes(threadId)) continue
      const file = path.join(entry.parentPath ?? entry.path ?? root, name)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs }
    }
  }
  return best?.file ?? null
}

function turnIdOf(record) {
  const payload = record?.payload
  return payload?.turn_id ?? payload?.turn_attribution?.turn_id ?? null
}

/**
 * Parse one rollout record. Returns a tiny projection so callers do not depend
 * on the full (and versioned) Codex event shape.
 */
export function projectRecord(record) {
  const payload = record?.payload
  if (!payload || typeof payload !== 'object') return null
  if (record.type === 'event_msg' && payload.type === 'task_started') {
    return { kind: 'task_started', turnId: turnIdOf(record) }
  }
  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    return { kind: 'task_complete', turnId: turnIdOf(record), lastAgentMessage: payload.last_agent_message ?? null }
  }
  if (record.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item ?? {}
    if (item.type === 'AgentMessage') {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => part?.text ?? '').join('')
        : ''
      return { kind: 'agent_message', turnId: turnIdOf(record), text, phase: item.phase ?? null }
    }
    if (item.type === 'UserMessage') {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => part?.text ?? '').join('')
        : ''
      return { kind: 'user_message', turnId: turnIdOf(record), text }
    }
  }
  if (record.type === 'response_item' && payload.type === 'message') {
    const text = Array.isArray(payload.content)
      ? payload.content.map((part) => part?.text ?? '').join('')
      : ''
    if (payload.role === 'user') return { kind: 'user_message_raw', text, turnId: payload?.internal_chat_message_metadata_passthrough?.turn_id ?? null }
    if (payload.role === 'assistant') return { kind: 'agent_message_raw', text, turnId: payload?.internal_chat_message_metadata_passthrough?.turn_id ?? null }
  }
  return null
}

export async function readRecordsSince(file, offset) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch {
    return { records: [], nextOffset: offset, missing: true }
  }
  try {
    const stat = await handle.stat()
    if (stat.size <= offset) return { records: [], nextOffset: stat.size }
    const length = stat.size - offset
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    const text = buffer.toString('utf8')
    const lines = text.split('\n')
    const tail = lines.pop() ?? ''
    const records = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // A torn line is possible while Codex is writing; ignore it and let the
        // next poll start after the last complete line.
      }
    }
    return { records, nextOffset: stat.size - Buffer.byteLength(tail, 'utf8') }
  } finally {
    await handle.close().catch(() => {})
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

function runQueueCommand({ executable, threadId, text, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executable, ['queue', '--thread', threadId, '--message', text], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, errorCode: error?.code === 'ENOENT' ? 'codex:not-found' : 'codex:queue-failed' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, timedOut: true, errorCode: 'codex:queue-timeout', stdout, stderr })
    }, Math.min(timeoutMs, 120000))
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
      finish({ ok: false, aborted: true, errorCode: 'codex:aborted', stdout, stderr })
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ ok: false, errorCode: error?.code === 'ENOENT' ? 'codex:not-found' : 'codex:queue-failed', stdout, stderr })
    })
    child.on('exit', (code) => {
      const queued = /Queued message\s+(\S+)\s+for thread\s+(\S+)/.exec(stdout)
      if (code === 0 && queued) finish({ ok: true, queuedId: queued[1], stdout, stderr })
      else finish({ ok: false, exitCode: code, errorCode: 'codex:queue-failed', stdout, stderr })
    })
  })
}

/**
 * Queue one turn and wait for its answer in the rollout file.
 * `marker` must be a substring of the user text we sent (the bridge header id).
 */
export async function runQueuedTurn({
  executable,
  threadId,
  text,
  marker,
  codexHome,
  timeoutMs = 900000,
  signal,
  pollMs = QUEUE_POLL_MS,
  onQueueAccepted,
  queueCommand = runQueueCommand,
} = {}) {
  if (!threadId) return { ok: false, errorCode: 'codex:thread-unknown', completed: false, sawAnyEvent: false }
  const home = codexHome || codexHomeFromEnv()
  const rollout = await findRollout(home, threadId)
  if (!rollout) return { ok: false, errorCode: 'codex:thread-not-found', completed: false, sawAnyEvent: false }

  let startOffset = 0
  try {
    startOffset = (await fsp.stat(rollout)).size
  } catch {}

  const queued = await queueCommand({ executable, threadId, text, timeoutMs, signal, marker })
  if (!queued.ok) return { ...queued, rollout, completed: false, sawAnyEvent: false }
  onQueueAccepted?.(queued.queuedId)

  const deadline = Date.now() + timeoutMs
  let offset = startOffset
  let turnId = null
  let replyText = ''
  let completed = false
  let sawTask = false

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { ok: false, aborted: true, errorCode: 'codex:aborted', rollout, turnId, replyText, completed, sawAnyEvent: sawTask }
    }
    const { records, nextOffset } = await readRecordsSince(rollout, offset)
    offset = nextOffset
    for (const record of records) {
      const event = projectRecord(record)
      if (!event) continue
      if (event.kind === 'user_message' && !turnId && event.text.includes(marker)) {
        turnId = event.turnId
        sawTask = true
      }
      if (!turnId) continue
      if (event.kind === 'task_started' && event.turnId === turnId) sawTask = true
      if (event.kind === 'agent_message' && event.turnId === turnId) replyText = event.text
      if (event.kind === 'task_complete' && event.turnId === turnId) {
        completed = true
        if (!replyText && typeof event.lastAgentMessage === 'string') replyText = event.lastAgentMessage
      }
    }
    if (completed) break
    await delay(pollMs, signal)
  }

  if (!completed) {
    return { ok: false, timedOut: true, errorCode: 'codex:timeout', rollout, turnId, replyText, completed, sawAnyEvent: sawTask }
  }
  const replyBytes = Buffer.byteLength(replyText, 'utf8')
  return {
    ok: replyBytes > 0,
    completed: true,
    sawAnyEvent: true,
    rollout,
    turnId,
    replyText,
    replyBytes,
    sessionId: threadId,
    errorCode: replyBytes > 0 ? null : 'codex:empty-reply',
  }
}
