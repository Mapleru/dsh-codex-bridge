import crypto from 'node:crypto'

export const MESSAGE_KINDS = Object.freeze(['message', 'reply'])
export const MAX_HOPS_HARD_LIMIT = 1000
export const ROUTE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function newMessageId() {
  return crypto.randomUUID()
}

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Validate one inbox record. Unknown fields are ignored; every field that
 * affects routing, loop protection or limits is checked.
 *
 * `from`/`to` are the direction the caller expects for that inbox, so a
 * message written to the wrong mailbox is rejected instead of silently
 * delivering to the wrong side.
 *
 * `route` is optional at the protocol level: a mailbox with a single route
 * keeps working, while a multi-route mailbox rejects messages that do not name
 * a route (the bridge parks them as `route-required` rather than guessing).
 */
export function validateMessage(value, { from, to, maxMessageBytes }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid-record', detail: 'record is not a JSON object' }
  }
  if (!isUuid(value.id)) return { ok: false, code: 'invalid-id', detail: 'id is not a UUID' }
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) {
    return { ok: false, code: 'invalid-at', detail: 'at is not an ISO8601 timestamp' }
  }
  if (value.from !== from) return { ok: false, code: 'invalid-from', detail: `from must be ${from}` }
  if (value.to !== to) return { ok: false, code: 'invalid-to', detail: `to must be ${to}` }
  if (!MESSAGE_KINDS.includes(value.kind)) return { ok: false, code: 'invalid-kind', detail: 'kind must be message or reply' }
  if (typeof value.text !== 'string' || value.text.trim() === '') {
    return { ok: false, code: 'invalid-text', detail: 'text must be a non-empty string' }
  }
  if (Number.isFinite(maxMessageBytes) && byteLength(value.text) > maxMessageBytes) {
    return { ok: false, code: 'message-too-large', detail: `text exceeds ${maxMessageBytes} bytes` }
  }
  if (!Number.isInteger(value.hops) || value.hops < 1 || value.hops > MAX_HOPS_HARD_LIMIT) {
    return { ok: false, code: 'invalid-hops', detail: `hops must be an integer in 1..${MAX_HOPS_HARD_LIMIT}` }
  }

  const route = value.route ?? null
  if (route !== null && (typeof route !== 'string' || !ROUTE_ID_RE.test(route))) {
    return { ok: false, code: 'invalid-route', detail: `route must match ${ROUTE_ID_RE}` }
  }

  const hasReplyTo = value.replyTo !== null && value.replyTo !== undefined
  if (value.kind === 'reply') {
    if (!isUuid(value.replyTo)) return { ok: false, code: 'invalid-reply-to', detail: 'reply requires a UUID replyTo' }
  } else if (hasReplyTo) {
    return { ok: false, code: 'invalid-reply-to', detail: 'message kind must use replyTo: null' }
  }

  return {
    ok: true,
    message: {
      id: value.id,
      at: value.at,
      from: value.from,
      to: value.to,
      kind: value.kind,
      text: value.text,
      hops: value.hops,
      replyTo: value.kind === 'reply' ? value.replyTo : null,
      route,
    },
  }
}

export function makeMessage({
  from,
  to,
  text,
  hops,
  replyTo = null,
  route = null,
  id = newMessageId(),
  at = new Date().toISOString(),
}) {
  return {
    id,
    at,
    from,
    to,
    kind: replyTo ? 'reply' : 'message',
    text,
    hops: Number.isInteger(hops) ? hops : 1,
    replyTo: replyTo ?? null,
    route: route ?? null,
  }
}

/**
 * What Codex actually receives on stdin. The header is metadata only: it lets
 * the Codex side answer with the right replyTo without guessing, and it makes
 * the route visible so a multi-route collaboration can name it back.
 */
export function promptTextFor(message) {
  const header = [
    '[codex-bridge]',
    `id: ${message.id}`,
    `route: ${message.route ?? 'default'}`,
    `hops: ${message.hops}`,
    `replyTo: ${message.replyTo ?? 'none'}`,
  ].join('\n')
  return `${header}\n\n${message.text}\n`
}

export function promptRequestId(messageId) {
  return `codex-bridge:${messageId}`
}
