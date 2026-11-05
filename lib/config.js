import path from 'node:path'

import { ROUTE_ID_RE } from './protocol.js'

export { ROUTE_ID_RE }

/**
 * Effective defaults. Every limit is deliberately configurable so an operator
 * can make the mailbox smaller on a constrained disk or larger for long
 * reports; the schema in cordis.patch.yml mirrors these numbers.
 */
export const DEFAULT_CONFIG = Object.freeze({
  root: '',
  dshSessionId: '',
  codexSessionId: '',
  codexExecutable: '',
  codexWorkingDirectory: '',
  codexTimeoutMs: 900000,
  maxHops: 6,
  maxAttempts: 3,
  maxQueueDepth: 20,
  maxMessageBytes: 32768,
  maxMailboxBytes: 8 * 1024 * 1024,
  pollIntervalMs: 2000,
  debounceMs: 300,
  retryBaseMs: 5000,
  shutdownTimeoutMs: 4000,
  model: '',
  deliverySource: 'webhook',
  deliveryMode: 'followup',
  transport: 'auto',
})

export const DELIVERY_SOURCES = Object.freeze(['webhook', 'user'])
export const DELIVERY_MODES = Object.freeze(['followup', 'steer'])
// exec: spawn `codex exec resume` (the bridge owns the process).
// queue: hand the turn to the shared app-server, for threads another process
//        (the desktop app) holds with an exclusive writer.
// auto: exec first, fall back to queue only on "active writer".
export const TRANSPORTS = Object.freeze(['auto', 'exec', 'queue'])

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function normalizeRoute(raw, index, top) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const id = asString(r.id) || (index === 0 ? 'default' : `route-${index + 1}`)
  return {
    id,
    dshSessionId: asString(r.dshSessionId) || top.dshSessionId,
    // null means "create a Codex thread on first use"; a string must be a known
    // thread id. An already-bound route never silently creates a new one.
    codexSessionId: asString(r.codexSessionId) || asString(top.codexSessionId) || null,
    codexWorkingDirectory: asString(r.codexWorkingDirectory) || top.codexWorkingDirectory,
    model: asString(r.model) || top.model,
    transport: TRANSPORTS.includes(asString(r.transport)) ? asString(r.transport) : top.transport,
  }
}

/**
 * Normalize raw Cordis config into the exact shape the bridge uses.
 *
 * `routes` is the authoritative list. The legacy top-level `dshSessionId` /
 * `codexWorkingDirectory` / `model` / `codexSessionId` fields describe a single
 * route named `default`, so existing profile rows keep working unchanged.
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const deliverySource = DELIVERY_SOURCES.includes(asString(c.deliverySource)) ? asString(c.deliverySource) : DEFAULT_CONFIG.deliverySource
  const deliveryMode = DELIVERY_MODES.includes(asString(c.deliveryMode)) ? asString(c.deliveryMode) : DEFAULT_CONFIG.deliveryMode

  const base = {
    dshSessionId: asString(c.dshSessionId),
    codexSessionId: asString(c.codexSessionId),
    codexWorkingDirectory: asString(c.codexWorkingDirectory),
    model: asString(c.model),
    transport: TRANSPORTS.includes(asString(c.transport)) ? asString(c.transport) : DEFAULT_CONFIG.transport,
  }

  const rawRoutes = Array.isArray(c.routes) ? c.routes.filter((item) => item && typeof item === 'object') : []
  const routes = rawRoutes.length > 0
    ? rawRoutes.map((item, index) => normalizeRoute(item, index, base))
    : [normalizeRoute({}, 0, base)]

  const first = routes[0]
  return {
    root: asString(c.root),
    // Legacy mirrors, kept for snapshots and for single-route callers.
    dshSessionId: first.dshSessionId,
    codexSessionId: first.codexSessionId ?? '',
    codexWorkingDirectory: first.codexWorkingDirectory,
    codexExecutable: asString(c.codexExecutable),
    codexTimeoutMs: asInt(c.codexTimeoutMs, DEFAULT_CONFIG.codexTimeoutMs, 1000, 24 * 60 * 60 * 1000),
    maxHops: asInt(c.maxHops, DEFAULT_CONFIG.maxHops, 1, 1000),
    maxAttempts: asInt(c.maxAttempts, DEFAULT_CONFIG.maxAttempts, 1, 10),
    maxQueueDepth: asInt(c.maxQueueDepth, DEFAULT_CONFIG.maxQueueDepth, 1, 10000),
    maxMessageBytes: asInt(c.maxMessageBytes, DEFAULT_CONFIG.maxMessageBytes, 256, 4 * 1024 * 1024),
    maxMailboxBytes: asInt(c.maxMailboxBytes, DEFAULT_CONFIG.maxMailboxBytes, 64 * 1024, 512 * 1024 * 1024),
    pollIntervalMs: asInt(c.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 250, 60000),
    debounceMs: asInt(c.debounceMs, DEFAULT_CONFIG.debounceMs, 0, 10000),
    retryBaseMs: asInt(c.retryBaseMs, DEFAULT_CONFIG.retryBaseMs, 100, 600000),
    shutdownTimeoutMs: asInt(c.shutdownTimeoutMs, DEFAULT_CONFIG.shutdownTimeoutMs, 500, 4500),
    model: first.model,
    deliverySource,
    deliveryMode,
    routes,
  }
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Structural validation only. Runtime capability (Codex version, DSH session
 * presence) is checked separately and never assumed from config alone.
 */
export function validateConfig(config) {
  const reasons = []
  const push = (code, message) => reasons.push({ code, message })

  if (!config.root) push('config:root-missing', 'root is empty')
  else if (!path.isAbsolute(config.root)) push('config:root-not-absolute', 'root must be an absolute path')

  if (!config.codexExecutable) push('config:executable-missing', 'codexExecutable is empty')
  else if (!path.isAbsolute(config.codexExecutable)) push('config:executable-not-absolute', 'codexExecutable must be an absolute path')

  const seen = new Set()
  for (const route of config.routes) {
    if (!ROUTE_ID_RE.test(route.id)) {
      push('config:route-id-invalid', `route id "${route.id}" must match ${ROUTE_ID_RE}`)
    } else if (seen.has(route.id)) {
      push('config:route-id-duplicate', `route id "${route.id}" is listed more than once`)
    }
    seen.add(route.id)

    if (!route.dshSessionId) push('config:session-missing', `route "${route.id}" has no dshSessionId`)
    if (!route.codexWorkingDirectory) push('config:cwd-missing', `route "${route.id}" has no codexWorkingDirectory`)
    else if (!path.isAbsolute(route.codexWorkingDirectory)) {
      push('config:cwd-not-absolute', `route "${route.id}" codexWorkingDirectory must be an absolute path`)
    }

    if (!route.codexSessionId) continue
    if (typeof route.codexSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(route.codexSessionId)) {
      push('config:codex-session-invalid', `route "${route.id}" codexSessionId is not a UUID`)
    }
  }

  if (config.root && path.isAbsolute(config.root)) {
    for (const route of config.routes) {
      if (!route.codexWorkingDirectory || !path.isAbsolute(route.codexWorkingDirectory)) continue
      if (!isInside(route.codexWorkingDirectory, config.root)) {
        push(
          'config:root-outside-cwd',
          `root must be inside codexWorkingDirectory of route "${route.id}" so Codex can write the mailbox inside its sandbox`,
        )
      }
    }
  }

  if (config.maxMessageBytes > config.maxMailboxBytes) {
    push('config:message-larger-than-mailbox', 'maxMessageBytes must not exceed maxMailboxBytes')
  }

  return { ok: reasons.length === 0, reasons }
}

/** Resolve a route by id; `fallbackSingle` allows an omitted route when only one exists. */
export function findRoute(config, routeId, { fallbackSingle = false } = {}) {
  if (routeId) return config.routes.find((route) => route.id === routeId) ?? null
  if (fallbackSingle && config.routes.length === 1) return config.routes[0]
  return null
}
