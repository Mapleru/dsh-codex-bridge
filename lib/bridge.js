import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { buildArgs, OUT_FILE, probeCodex as defaultProbeCodex, runCodex } from './codex-cli.js'
import { codexHomeFromEnv, runQueuedTurn } from './codex-queue.js'
import { findRoute, normalizeConfig, validateConfig } from './config.js'
import {
  appendEvent,
  appendJsonLine,
  countPendingLines,
  ensureLayout,
  FILES,
  fileSize,
  findMessage,
  findReplyTo,
  isMailboxError,
  isProcessAlive,
  MailboxError,
  pathExists,
  readCursor,
  readInstanceLock,
  readJsonFile,
  readRecords,
  readBatch,
  releaseInstanceLock,
  acquireInstanceLock,
  rotateMailbox,
  skipToNextNewline,
  writeCursor,
  writeFileAtomic,
  writeJsonAtomic,
} from './mailbox.js'
import { isUuid, makeMessage, promptTextFor, validateMessage } from './protocol.js'

export const BRIDGE_VERSION = 1

const MAX_TICK_DELIVERIES = 20
const MAX_TICK_INVOCATIONS = 5
const STATE_MIN_INTERVAL_MS = 200

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function safeDetail(value) {
  return typeof value === 'string' ? value.slice(0, 200) : undefined
}

export class Bridge {
  /**
   * @param {object} options
   * @param {object} options.config raw Cordis config
   * @param {(message: object) => Promise<{accepted: boolean, error?: {code: string}}>} options.deliver
   * @param {() => Promise<{ok: boolean, code?: string}>} [options.probeSession]
   * @param {(executable: string) => Promise<object>} [options.probeCodex]
   * @param {(options: object) => Promise<object>} [options.runner]
   * @param {boolean} [options.watch]
   * @param {boolean} [options.autoTick]
   * @param {string|null} [options.helperSource] absolute path to tools/send.mjs to copy into the mailbox
   */
  constructor(options) {
    this.config = normalizeConfig(options.config)
    this.logger = options.logger ?? console
    this.deliver = options.deliver ?? (async () => ({ accepted: false, error: { code: 'delivery-not-configured' } }))
    this.probeSession = options.probeSession ?? null
    this.probeCodex = options.probeCodex ?? defaultProbeCodex
    this.runner = options.runner ?? runCodex
    this.queueRunner = options.queueRunner ?? runQueuedTurn
    this.codexHome = options.codexHome ?? codexHomeFromEnv()
    this.watch = options.watch !== false
    this.autoTick = options.autoTick !== false
    this.now = options.now ?? (() => Date.now())
    this.helperSource = options.helperSource ?? null

    this.instanceId = crypto.randomUUID()
    this.startedAt = new Date(this.now()).toISOString()
    this.started = false
    this.disposed = false
    this.lockOwned = false
    this.lockState = 'none'
    this.lockOwner = null

    this.reasons = new Map()
    this.configOk = false
    this.dshSessionReady = !this.probeSession
    this.codexStatus = null
    this.codexReady = false
    this.sessionId = null
    this.sessionLost = false
    this.sessionIdUnavailable = false
    this.sessionMeta = null
    this.lastResetAt = 0

    // Per-route Codex thread bindings. `routes.json` is authoritative; the
    // legacy `session.json` is only migrated from and still honoured for the
    // default route so existing mailboxes keep working.
    this.routeStore = { version: 1, routes: {} }
    this.routesMtimeMs = 0
    this.delivered = new Set()
    this.routeDshReady = new Map()

    this.stopFile = false
    this.stoppedPending = false
    this.stopLatched = false
    this.stopChecking = null
    this.current = null
    this.currentPromise = null
    this.abortController = null
    this.deliveryAbort = null
    this.currentPid = null

    this.cursorDsh = 0
    this.cursorCodex = 0
    this.pendingDsh = []
    this.pendingCodex = []
    this.nextDshAt = 0
    this.nextCodexAt = 0
    this.nextSessionProbeAt = 0
    this.nextCodexProbeAt = 0
    this.dshFailures = 0

    this.ticking = false
    this.pendingTick = false
    this.tickPromise = null
    this.watcher = null
    this.interval = null
    this.debounceTimer = null
    this.rearmTimer = null
    this.delayResolve = null
    this.delayTimer = null

    this.metrics = { depthCodex: 0, depthDsh: 0, parked: 0 }
    this.lastErrorCode = null
    this.attention = null
    this.stateHash = ''
    this.lastStateWrite = 0
    this.wroteState = false
  }

  get root() {
    return this.config.root
  }

  get processingPath() {
    return path.join(this.root, FILES.processing)
  }

  get stopPath() {
    return path.join(this.root, FILES.stop)
  }

  get sessionPath() {
    return path.join(this.root, FILES.session)
  }

  get routesPath() {
    return path.join(this.root, FILES.routes)
  }

  get defaultRoute() {
    return this.config.routes[0]
  }

  bindingFor(routeId) {
    const entry = this.routeStore.routes?.[routeId]
    if (!entry || typeof entry.codexSessionId !== 'string') return null
    return entry.codexSessionId || null
  }

  routeIsLost(routeId) {
    return Boolean(this.routeStore.routes?.[routeId]?.lostAt)
  }

  routeIsUnavailable(routeId) {
    return Boolean(this.routeStore.routes?.[routeId]?.unavailableAt)
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.runStart()
    return this.startPromise
  }

  async runStart() {
    if (this.started) return this.snapshot()
    this.started = true

    const validation = validateConfig(this.config)
    this.configOk = validation.ok
    for (const reason of validation.reasons) this.addReason(reason.code, reason.message)
    if (!validation.ok) {
      this.log('warn', 'config-invalid', { reasons: validation.reasons.map((item) => item.code) })
      return this.snapshot()
    }

    try {
      await ensureLayout(this.root)
    } catch (error) {
      this.configOk = false
      this.addReason('root:unwritable', `cannot create mailbox layout: ${error.code ?? 'error'}`)
      return this.snapshot()
    }
    if (this.disposed) return this.snapshot()

    const lock = await acquireInstanceLock(this.root, {
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      dshSessionId: this.config.dshSessionId,
      plugin: 'dsh-codex-bridge',
    }).catch((error) => ({ acquired: false, reason: error.code ?? 'lock-error', owner: null }))

    if (!lock.acquired) {
      this.lockState = 'locked'
      this.lockOwner = lock.owner ?? null
      this.addReason('instance:locked', `another instance holds the lock (${lock.reason ?? 'unknown'})`)
      this.log('warn', 'instance-locked', { reason: lock.reason ?? 'unknown', ownerPid: lock.owner?.pid ?? null })
      return this.snapshot()
    }

    this.lockOwned = true
    this.lockState = 'owned'

    try {
      this.cursorDsh = await readCursor(this.root, FILES.cursorDsh)
      this.cursorCodex = await readCursor(this.root, FILES.cursorCodex)
      await this.loadSession()
      await this.recover()
      await this.installHelper()
      if (this.disposed) return this.snapshot()
      this.codexStatus = await this.safeProbeCodex()
      this.applyCodexStatus()
      if (this.disposed) return this.snapshot()
      if (this.probeSession) {
        const probe = await this.safeProbeSession()
        this.applySessionProbe(probe)
      }
      this.updateReady()
      if (this.disposed) return this.snapshot()
      this.startWatcher()
      this.startTimers()
      await this.refreshMetrics()
      await this.writeState(true)
      this.log('info', 'started', {
        instanceId: this.instanceId,
        ready: this.ready,
        reasons: this.reasonCodes(),
      })
      if (this.autoTick) this.schedule(0)
    } catch (error) {
      this.noteError(error)
      await this.writeState(true)
    }
    return this.snapshot()
  }

  async stop() {
    if (this.disposed) return
    this.disposed = true
    // Host-exit measurement: pair this timestamp with an external observer
    // of the host process lifetime. Best effort; shutdown must not wait on it.
    await this.event('shutdown-begin', {}).catch(() => {})
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.rearmTimer) clearTimeout(this.rearmTimer)
    if (this.interval) clearInterval(this.interval)
    this.debounceTimer = null
    this.rearmTimer = null
    this.interval = null
    this.clearDelay()
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* ignore */
      }
      this.watcher = null
    }
    if (this.abortController) {
      try {
        this.abortController.abort()
      } catch {
        /* ignore */
      }
    }
    if (this.deliveryAbort) {
      try {
        this.deliveryAbort.abort()
      } catch {
        /* ignore */
      }
    }
    await this.waitCurrent(this.config.shutdownTimeoutMs)
    const starting = this.startPromise
    if (starting) {
      await Promise.race([starting.catch(() => {}), sleep(this.config.shutdownTimeoutMs)])
    }
    const tick = this.tickPromise
    if (tick) {
      await Promise.race([tick.catch(() => {}), sleep(this.config.shutdownTimeoutMs)])
    }
    if (this.lockOwned) {
      await releaseInstanceLock(this.root, this.instanceId).catch(() => {})
      this.lockOwned = false
      this.lockState = 'none'
    }
    this.log('info', 'stopped', { instanceId: this.instanceId })
  }

  /* ---------------------------------------------------------------- */
  /* Reasons / ready                                                   */
  /* ---------------------------------------------------------------- */

  addReason(code, message) {
    if (!code) return
    this.reasons.set(code, { code, message: safeDetail(message) ?? code })
  }

  removeReason(code) {
    this.reasons.delete(code)
  }

  reasonCodes() {
    return [...this.reasons.keys()].sort()
  }

  get ready() {
    return (
      this.configOk &&
      this.lockOwned &&
      !this.disposed &&
      this.dshSessionReady &&
      this.codexReady
    )
  }

  applyCodexStatus() {
    this.removeReason('codex:not-ready')
    this.removeReason('codex:missing-capabilities')
    this.codexStatus = this.codexStatus ?? null
    if (!this.codexStatus?.ok) {
      this.addReason('codex:not-ready', this.codexStatus?.error ?? 'codex probe did not succeed')
      if (this.codexStatus?.missing?.length) {
        this.addReason('codex:missing-capabilities', `missing: ${this.codexStatus.missing.join(',')}`)
      }
    }
    this.updateCodexReasons()
  }

  updateCodexReasons() {
    if (this.sessionLost) this.addReason('codex:session-lost', 'the Codex session id can no longer be resumed; run tools/ctl.mjs reset-session')
    else this.removeReason('codex:session-lost')
    if (this.sessionIdUnavailable) {
      this.addReason('codex:session-id-unavailable', 'Codex returned no thread id; continuity cannot be claimed; run tools/ctl.mjs reset-session')
    } else this.removeReason('codex:session-id-unavailable')
    this.codexReady = Boolean(this.codexStatus?.ok) && !this.sessionLost && !this.sessionIdUnavailable
  }

  updateReady() {
    this.updateCodexReasons()
  }

  applySessionProbe(probe) {
    this.removeReason('dsh:session-not-found')
    this.removeReason('dsh:controller-unavailable')
    if (Array.isArray(probe?.routes)) {
      this.routeDshReady = new Map(probe.routes.map((item) => [item.id, Boolean(item.ok)]))
      const failed = probe.routes.filter((item) => !item.ok)
      this.dshSessionReady = failed.length < probe.routes.length
      if (failed.length > 0) {
        const detail = failed.map((item) => `${item.id}:${item.code ?? 'not-found'}`).join(', ')
        this.addReason('dsh:route-session-missing', `DSH session missing for route(s): ${detail}`)
      } else {
        this.removeReason('dsh:route-session-missing')
      }
      return
    }
    if (probe?.ok) {
      this.dshSessionReady = true
      return
    }
    this.dshSessionReady = false
    if (probe?.code === 'session-controller-unavailable') {
      this.addReason('dsh:controller-unavailable', 'sessionController service is not available')
    } else {
      this.addReason('dsh:session-not-found', `DSH session ${this.config.dshSessionId} is not available (${probe?.code ?? 'resolve-failed'})`)
    }
  }

  async safeProbeCodex() {
    try {
      return await this.probeCodex(this.config.codexExecutable)
    } catch (error) {
      this.noteError(error)
      return { ok: false, error: 'codex:probe-failed', executable: this.config.codexExecutable }
    }
  }

  async safeProbeSession() {
    try {
      return await this.probeSession()
    } catch (error) {
      return { ok: false, code: error.code ?? 'gateway/internal' }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Session identity                                                  */
  /* ---------------------------------------------------------------- */

  async loadSession() {
    const store = await readJsonFile(this.routesPath, null)
    if (store && typeof store === 'object' && store.routes && typeof store.routes === 'object') {
      this.routeStore = { version: 1, ...store, routes: { ...store.routes } }
    } else {
      this.routeStore = { version: 1, routes: {} }
      const legacy = await readJsonFile(this.sessionPath, null)
      if (legacy && typeof legacy === 'object' && typeof legacy.sessionId === 'string' && legacy.sessionId) {
        this.routeStore.routes[this.defaultRoute.id] = {
          codexSessionId: legacy.sessionId,
          updatedAt: legacy.updatedAt ?? null,
          migratedFrom: FILES.session,
        }
      }
    }

    // A configured id seeds a route that has never run; a stored id always wins
    // (ctl reset-session is the only way to drop or replace a binding).
    for (const route of this.config.routes) {
      if (route.codexSessionId && !this.bindingFor(route.id)) {
        this.routeStore.routes[route.id] = {
          codexSessionId: route.codexSessionId,
          updatedAt: new Date(this.now()).toISOString(),
          fromConfig: true,
        }
      }
    }

    this.sessionMeta = await readJsonFile(this.sessionPath, null)
    this.lastResetAt = Date.parse(this.sessionMeta?.resetAt ?? '') || 0
    this.applyDefaultMirrors()
    this.routesMtimeMs = (await fsp.stat(this.routesPath).catch(() => null))?.mtimeMs ?? 0
    if (!store) await this.persistRoutes()
  }

  /** Default-route mirrors keep `snapshot()` and the legacy reasons meaningful. */
  applyDefaultMirrors() {
    const id = this.defaultRoute.id
    this.sessionId = this.bindingFor(id)
    this.sessionLost = this.routeIsLost(id)
    this.sessionIdUnavailable = this.routeIsUnavailable(id)
    this.updateCodexReasons()
  }

  async persistRoutes() {
    this.routeStore.updatedAt = new Date(this.now()).toISOString()
    await writeJsonAtomic(this.routesPath, this.routeStore).catch((error) => this.noteError(error))
    this.routesMtimeMs = (await fsp.stat(this.routesPath).catch(() => null))?.mtimeMs ?? 0
  }

  /**
   * Pick up `routes.json` edits (ctl bind / reset-session / operator edits).
   * Runs even mid-call: an in-flight message keeps the binding it started
   * with (processing.codexSessionId), so reloading cannot retarget it.
   */
  async syncRoutesFromDisk() {
    const stat = await fsp.stat(this.routesPath).catch(() => null)
    if (!stat || stat.mtimeMs === this.routesMtimeMs) return
    this.routesMtimeMs = stat.mtimeMs
    const store = await readJsonFile(this.routesPath, null).catch(() => null)
    if (!store || typeof store !== 'object' || !store.routes) return
    this.routeStore = { version: 1, ...store, routes: { ...store.routes } }
    this.applyDefaultMirrors()
    this.event('routes-reloaded', {})
  }

  async refreshRoutesMeta() {
    await this.syncRoutesFromDisk()
  }

  async refreshSessionMeta() {
    const meta = await readJsonFile(this.sessionPath, null).catch(() => null)
    if (!meta || typeof meta !== 'object') return
    const resetAt = Date.parse(meta.resetAt ?? '')
    if (Number.isFinite(resetAt) && resetAt !== this.lastResetAt && !this.current) {
      this.lastResetAt = resetAt
      this.sessionMeta = meta
      this.routeStore.routes[this.defaultRoute.id] = {
        codexSessionId: typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : null,
        updatedAt: new Date(this.now()).toISOString(),
        resetAt: meta.resetAt,
      }
      await this.persistRoutes()
      this.applyDefaultMirrors()
      this.event('session-reset', {})
      this.log('info', 'session-reset', {})
      return
    }
    if (!this.current && typeof meta.sessionId === 'string' && meta.sessionId && meta.sessionId !== this.sessionId) {
      // `session.json` is a legacy mirror. Only adopt it when it is newer
      // than the route it would overwrite, otherwise an old mirror silently
      // undoes `ctl bind`.
      const routeUpdated = Date.parse(this.routeStore.routes?.[this.defaultRoute.id]?.updatedAt ?? '')
      const metaUpdated = Date.parse(meta.updatedAt ?? '')
      const newer = Number.isFinite(metaUpdated) && (!Number.isFinite(routeUpdated) || metaUpdated > routeUpdated)
      if (newer) {
        this.routeStore.routes[this.defaultRoute.id] = {
          codexSessionId: meta.sessionId,
          updatedAt: new Date(this.now()).toISOString(),
        }
        await this.persistRoutes()
        this.applyDefaultMirrors()
        this.event('session-adopted', {})
      }
    }
  }

  async bindingOnDisk(routeId) {
    const store = await readJsonFile(this.routesPath, null).catch(() => null)
    const value = store?.routes?.[routeId]?.codexSessionId
    return typeof value === 'string' && value ? value : null
  }

  /**
   * A successful turn proves the binding is usable again. Drop stale error
   * codes left by an earlier loss, otherwise `routes.json` keeps claiming
   * `codex:session-lost` long after the route recovered.
   * @param {string} routeId
   */
  async clearRouteError(routeId) {
    const route = this.routeStore.routes?.[routeId]
    if (!route || (!('code' in route) && !('lastErrorCode' in route))) return
    delete route.code
    delete route.lastErrorCode
    await this.persistRoutes()
  }

  async recordSessionId(routeId, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return
    if (this.bindingFor(routeId) === sessionId) return
    this.routeStore.routes[routeId] = {
      codexSessionId: sessionId,
      updatedAt: new Date(this.now()).toISOString(),
    }
    if (routeId === this.defaultRoute.id) {
      // Legacy mirror: older tooling and docs read session.json.
      await writeJsonAtomic(this.sessionPath, { sessionId, updatedAt: new Date(this.now()).toISOString() }).catch(() => {})
    }
    await this.persistRoutes()
    this.applyDefaultMirrors()
    this.event('session-recorded', { route: routeId })
  }

  async markSessionLost(routeId, message, result, cursorAfter) {
    const previous = this.bindingFor(routeId)
    this.routeStore.routes[routeId] = {
      codexSessionId: null,
      previousSessionId: previous,
      lostAt: new Date(this.now()).toISOString(),
      code: result?.errorCode ?? 'codex:session-lost',
    }
    if (routeId === this.defaultRoute.id) {
      await writeJsonAtomic(this.sessionPath, {
        sessionId: null,
        previousSessionId: previous,
        lostAt: new Date(this.now()).toISOString(),
        code: result?.errorCode ?? 'codex:session-lost',
      }).catch(() => {})
    }
    await this.persistRoutes()
    this.applyDefaultMirrors()
    this.lastErrorCode = 'codex:session-lost'
    this.event('session-lost', { messageId: message.id, code: 'codex:session-lost' })
    await this.parkMessage(message, 'session-lost', cursorAfter, { detail: result?.errorCode ?? null })
  }

  /* ---------------------------------------------------------------- */
  /* Timers and scheduling                                             */
  /* ---------------------------------------------------------------- */

  startTimers() {
    if (!this.autoTick) return
    this.interval = setInterval(() => {
      void this.observeStop()
      void this.tick('interval')
    }, this.config.pollIntervalMs)
    this.interval.unref?.()
  }

  startWatcher() {
    if (!this.watch || this.disposed) return
    try {
      this.watcher = fs.watch(this.root, { persistent: false }, (_event, filename) => {
        if (this.disposed) return
        const name = typeof filename === 'string' ? filename : ''
        if (name === FILES.stop) {
          void this.observeStop()
          return
        }
        if (
          name &&
          ![
            FILES.inboxDsh,
            FILES.inboxCodex,
            FILES.processing,
            FILES.session,
            FILES.routes,
            FILES.appendLock,
          ].includes(name)
        ) {
          return
        }
        this.schedule()
      })
      this.watcher.on('error', (error) => {
        this.log('warn', 'watcher-error', { code: error.code ?? 'watch-error' })
        try {
          this.watcher?.close()
        } catch {
          /* ignore */
        }
        this.watcher = null
        if (!this.disposed) {
          this.rearmTimer = setTimeout(() => {
            this.rearmTimer = null
            this.startWatcher()
          }, 5000)
          this.rearmTimer.unref?.()
        }
      })
    } catch (error) {
      this.log('warn', 'watcher-unavailable', { code: error.code ?? 'watch-failed' })
      this.watcher = null
    }
  }

  schedule(delay = this.config.debounceMs) {
    if (this.disposed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.tick('debounce')
    }, Math.max(0, delay))
    this.debounceTimer.unref?.()
  }

  delay(ms) {
    this.clearDelay()
    return new Promise((resolve) => {
      this.delayResolve = resolve
      this.delayTimer = setTimeout(() => {
        this.delayTimer = null
        this.delayResolve = null
        resolve()
      }, Math.max(0, ms))
    })
  }

  clearDelay() {
    if (this.delayTimer) clearTimeout(this.delayTimer)
    const resolve = this.delayResolve
    this.delayTimer = null
    this.delayResolve = null
    if (resolve) resolve()
  }

  async waitCurrent(ms) {
    const promise = this.currentPromise
    if (!promise) return
    await Promise.race([promise.catch(() => {}), sleep(ms)])
  }

  /* ---------------------------------------------------------------- */
  /* Main loop                                                         */
  /* ---------------------------------------------------------------- */

  tick(reason = 'manual') {
    if (this.tickPromise) {
      this.pendingTick = true
      return this.tickPromise
    }
    const run = this.doTick(reason).finally(() => {
      this.tickPromise = null
      if (this.pendingTick && !this.disposed) {
        this.pendingTick = false
        this.schedule(0)
      }
    })
    this.tickPromise = run
    return run
  }

  /**
   * STOP is observed independently of the processing loop: a long Codex call
   * must not delay cancellation. This runs from the watcher and the interval.
   */
  observeStop() {
    if (this.stopChecking) return this.stopChecking
    const run = (async () => {
      if (!this.lockOwned || this.disposed) return
      const exists = await pathExists(this.stopPath).catch(() => false)
      if (exists === this.stopFile) return
      this.stopFile = exists
      if (exists) {
        await this.handleStop()
        await this.writeState()
      } else {
        this.stopLatched = false
        this.event('stop-cleared', {})
        if (this.stoppedPending) this.schedule(0)
      }
    })().finally(() => {
      this.stopChecking = null
    })
    this.stopChecking = run
    return run
  }

  async doTick(reason) {
    if (!this.lockOwned || this.disposed) return
    if (this.ticking) {
      this.pendingTick = true
      return
    }
    this.ticking = true
    try {
      await this.observeStop()
      // Reload routes first: refreshSessionMeta's adoption guard compares
      // against the route's updatedAt, so it must see the latest bind.
      await this.refreshRoutesMeta()
      await this.refreshSessionMeta()
      if (this.stopFile) {
        await this.refreshMetrics()
        await this.writeState()
        return
      }
      if (this.stoppedPending) await this.resolveStopped()

      if (!this.codexStatus?.ok && this.now() >= this.nextCodexProbeAt) {
        this.nextCodexProbeAt = this.now() + 60000
        this.codexStatus = await this.safeProbeCodex()
        this.applyCodexStatus()
        if (this.codexStatus.ok) this.event('codex-ready', {})
      }
      if (!this.dshSessionReady && this.probeSession && this.now() >= this.nextSessionProbeAt) {
        this.nextSessionProbeAt = this.now() + 30000
        this.applySessionProbe(await this.safeProbeSession())
        this.updateReady()
      }

      await this.pumpDsh()
      await this.pumpCodex()
      await this.refreshMetrics()
    } catch (error) {
      this.noteError(error)
    } finally {
      this.ticking = false
      await this.writeState()
    }
  }

  async refreshMetrics() {
    if (!this.lockOwned) return
    try {
      this.metrics.depthCodex = await countPendingLines(this.root, FILES.inboxCodex, this.cursorCodex, {
        limit: this.config.maxQueueDepth + 1,
      })
      this.metrics.depthDsh = await countPendingLines(this.root, FILES.inboxDsh, this.cursorDsh, {
        limit: this.config.maxQueueDepth + 1,
      })
      this.metrics.parked = await countPendingLines(this.root, FILES.parked, 0, { limit: 100000 })
    } catch (error) {
      if (!isMailboxError(error)) this.noteError(error)
    }
  }

  /**
   * Resolve a message to one configured route.
   *
   * A reply inherits the parent's route and may not contradict it; a message
   * without a route is only accepted when the mailbox has exactly one route.
   * No fallback and no auto-created route.
   */
  async resolveRoute(message) {
    let routeId = message.route ?? null
    if (message.replyTo) {
      const parent = await findMessage(this.root, message.replyTo, { maxBytes: this.config.maxMailboxBytes })
      if (!parent) return { code: 'reply-parent-unknown', detail: `replyTo ${message.replyTo} is not in the mailbox` }
      const parentRoute = parent.route ?? null
      if (routeId && parentRoute && routeId !== parentRoute) {
        return { code: 'route-mismatch', detail: `reply names route ${routeId} but its parent is on ${parentRoute}` }
      }
      routeId = routeId ?? parentRoute
    }
    if (!routeId) {
      if (this.config.routes.length === 1) return { route: this.config.routes[0] }
      return { code: 'route-required', detail: 'message has no route and the mailbox has more than one route' }
    }
    const route = findRoute(this.config, routeId)
    if (!route) return { code: 'route-unknown', detail: `route ${routeId} is not configured` }
    return { route }
  }

  async loadDelivered() {
    const { records } = await readRecords(this.root, FILES.delivered, { maxBytes: 4 * 1024 * 1024 }).catch(() => ({ records: [] }))
    for (const record of records) {
      if (record && typeof record.messageId === 'string') this.delivered.add(record.messageId)
    }
  }

  /**
   * Webhook delivery has no requestId idempotency, so the bridge records what
   * it handed to the session. A crash between the call and this append can
   * still duplicate one message; that window is documented, not hidden.
   */
  async markDelivered(messageId) {
    this.delivered.add(messageId)
    try {
      await appendJsonLine(
        this.root,
        FILES.delivered,
        { at: new Date(this.now()).toISOString(), messageId },
        { maxBytes: 4 * 1024 * 1024 },
      )
    } catch (error) {
      if (!isMailboxError(error)) this.noteError(error)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Codex -> DSH delivery                                             */
  /* ---------------------------------------------------------------- */

  async pumpDsh() {
    if (this.stopFile || this.disposed || !this.lockOwned) return
    if (this.now() < this.nextDshAt) return

    for (let delivered = 0; delivered < MAX_TICK_DELIVERIES; delivered += 1) {
      if (this.stopFile || this.disposed) return
      if (this.pendingDsh.length === 0) {
        const batch = await readBatch(this.root, FILES.inboxDsh, this.cursorDsh, {
          maxBytes: 256 * 1024,
          maxLines: 20,
        })
        if (batch.reset) {
          this.cursorDsh = 0
          await writeCursor(this.root, FILES.cursorDsh, 0)
          this.event('cursor-reset', { file: FILES.inboxDsh })
        }
        if (batch.overflow) {
          const next = await skipToNextNewline(this.root, FILES.inboxDsh, this.cursorDsh)
          if (next > this.cursorDsh) {
            await this.parkRaw(FILES.inboxDsh, '[record larger than read window]', 'oversized-record', next)
            this.cursorDsh = next
            continue
          }
        }
        if (batch.lines.length === 0) return
        this.pendingDsh = batch.lines
      }

      const line = this.pendingDsh[0]
      let parsed
      try {
        parsed = JSON.parse(line.raw)
      } catch {
        await this.parkRaw(FILES.inboxDsh, line.raw, 'invalid-json', line.end)
        this.pendingDsh.shift()
        this.cursorDsh = line.end
        continue
      }
      const validation = validateMessage(parsed, {
        from: 'codex',
        to: 'dsh',
        maxMessageBytes: this.config.maxMessageBytes,
      })
      if (!validation.ok) {
        await this.parkRaw(FILES.inboxDsh, line.raw, validation.code, line.end, validation.detail)
        this.pendingDsh.shift()
        this.cursorDsh = line.end
        continue
      }

      const message = validation.message
      const routeResult = await this.resolveRoute(message)
      if (!routeResult.route) {
        await this.parkMessage(message, routeResult.code, line.end, { detail: routeResult.detail })
        this.pendingDsh.shift()
        this.cursorDsh = line.end
        this.event(routeResult.code, { messageId: message.id, hops: message.hops })
        continue
      }
      message.route = routeResult.route.id

      if (this.delivered.has(message.id)) {
        this.pendingDsh.shift()
        this.cursorDsh = line.end
        await writeCursor(this.root, FILES.cursorDsh, line.end)
        this.event('delivery-deduped', { messageId: message.id })
        continue
      }

      let result
      const deliveryController = new AbortController()
      this.deliveryAbort = deliveryController
      try {
        result = await this.deliver(message, { signal: deliveryController.signal, route: routeResult.route })
      } catch (error) {
        result = { accepted: false, error: { code: error.code ?? 'delivery-exception' } }
      } finally {
        this.deliveryAbort = null
      }
      if (this.stopFile || this.disposed) return

      if (result?.accepted) {
        await this.markDelivered(message.id)
        this.cursorDsh = line.end
        await writeCursor(this.root, FILES.cursorDsh, line.end)
        this.pendingDsh.shift()
        this.dshFailures = 0
        this.nextDshAt = 0
        this.lastErrorCode = null
        this.dshSessionReady = true
        this.removeReason('dsh:session-not-found')
        this.event('delivered', { messageId: message.id, chars: message.text.length, hops: message.hops, route: message.route })
        continue
      }

      const code = result?.error?.code ?? 'delivery-failed'
      this.lastErrorCode = code
      if (code === 'session/not-found' && message.route !== this.defaultRoute.id) {
        // One route's session being closed must not stall the others.
        await this.parkMessage(message, 'route-target-missing', line.end, { detail: code })
        this.pendingDsh.shift()
        this.cursorDsh = line.end
        this.event('route-target-missing', { messageId: message.id, route: message.route })
        continue
      }
      if (code === 'session/not-found') {
        this.dshSessionReady = false
        this.addReason('dsh:session-not-found', `DSH session ${this.config.dshSessionId} is not available`)
        this.nextDshAt = this.now() + Math.max(30000, this.config.retryBaseMs)
        this.nextSessionProbeAt = this.now() + 30000
        this.event('resolve-failed', { messageId: message.id, code })
        this.log('warn', 'resolve-failed', { messageId: message.id, code })
        return
      }

      this.dshFailures += 1
      const backoff = Math.min(this.config.retryBaseMs * 2 ** (this.dshFailures - 1), 60000)
      this.nextDshAt = this.now() + backoff
      this.event('delivery-retry', { messageId: message.id, code, status: `retry-in-${backoff}ms` })
      this.log('warn', 'delivery-retry', { messageId: message.id, code, backoff })
      return
    }
  }

  /* ---------------------------------------------------------------- */
  /* DSH -> Codex invocation                                           */
  /* ---------------------------------------------------------------- */

  /**
   * `ctl.mjs retry` rewinds `cursor-codex` on disk; the running bridge keeps its
   * own cursor in memory, so pick the rewind up on the next tick instead of
   * requiring a disable/enable cycle.
   */
  async syncCursorRewind() {
    if (this.current) return
    const disk = await readCursor(this.root, FILES.cursorCodex).catch(() => null)
    if (typeof disk === 'number' && disk < this.cursorCodex) {
      this.event('cursor-rewound', { file: FILES.cursorCodex, from: this.cursorCodex, to: disk })
      this.cursorCodex = disk
      this.pendingCodex = []
    }
  }

  async pumpCodex() {
    if (this.stopFile || this.disposed || !this.lockOwned) return
    if (!this.codexReady || this.current) return
    if (this.now() < this.nextCodexAt) return
    await this.syncCursorRewind()
    await this.syncRoutesFromDisk()
    if (await this.resumePendingReply()) return

    for (let invocation = 0; invocation < MAX_TICK_INVOCATIONS; invocation += 1) {
      if (this.stopFile || this.disposed || !this.codexReady || this.current) return
      if (this.pendingCodex.length === 0) {
        const batch = await readBatch(this.root, FILES.inboxCodex, this.cursorCodex, {
          maxBytes: 256 * 1024,
          maxLines: 20,
        })
        if (batch.reset) {
          this.cursorCodex = 0
          await writeCursor(this.root, FILES.cursorCodex, 0)
          this.event('cursor-reset', { file: FILES.inboxCodex })
        }
        if (batch.overflow) {
          const next = await skipToNextNewline(this.root, FILES.inboxCodex, this.cursorCodex)
          if (next > this.cursorCodex) {
            await this.parkRaw(FILES.inboxCodex, '[record larger than read window]', 'oversized-record', next)
            this.cursorCodex = next
            continue
          }
        }
        if (batch.lines.length === 0) return
        this.pendingCodex = batch.lines
      }

      const line = this.pendingCodex[0]
      let parsed
      try {
        parsed = JSON.parse(line.raw)
      } catch {
        await this.parkRaw(FILES.inboxCodex, line.raw, 'invalid-json', line.end)
        this.pendingCodex.shift()
        this.cursorCodex = line.end
        continue
      }
      const validation = validateMessage(parsed, {
        from: 'dsh',
        to: 'codex',
        maxMessageBytes: this.config.maxMessageBytes,
      })
      if (!validation.ok) {
        await this.parkRaw(FILES.inboxCodex, line.raw, validation.code, line.end, validation.detail)
        this.pendingCodex.shift()
        this.cursorCodex = line.end
        continue
      }

      const message = validation.message
      const routeResult = await this.resolveRoute(message)
      if (!routeResult.route) {
        await this.parkMessage(message, routeResult.code, line.end, { detail: routeResult.detail })
        this.pendingCodex.shift()
        this.cursorCodex = line.end
        this.event(routeResult.code, { messageId: message.id, hops: message.hops })
        continue
      }
      const route = routeResult.route
      message.route = route.id

      if (this.routeIsLost(route.id)) {
        await this.parkMessage(message, 'session-lost', line.end, {
          detail: `route ${route.id} has no resumable Codex thread; run ctl reset-session --route ${route.id}`,
        })
        this.pendingCodex.shift()
        this.cursorCodex = line.end
        this.event('session-lost', { messageId: message.id })
        continue
      }

      if (message.hops >= this.config.maxHops) {
        await this.parkMessage(message, 'hop-limit', line.end, {
          detail: `hops ${message.hops} >= maxHops ${this.config.maxHops}`,
        })
        this.pendingCodex.shift()
        this.cursorCodex = line.end
        this.event('hop-limit', { messageId: message.id, hops: message.hops })
        continue
      }

      this.pendingCodex.shift()
      await this.runMessage(message, route, line.end)
      if (this.stopFile || this.disposed || !this.codexReady || this.current) return
    }
  }

  async runMessage(message, route, cursorAfter) {
    const outFile = OUT_FILE(this.root, message.id)
    const processing = {
      messageId: message.id,
      phase: 'running',
      startedAt: new Date(this.now()).toISOString(),
      attempt: 1,
      cursorAfter,
      hops: message.hops,
      replyTo: message.replyTo,
      routeId: route.id,
      outFile: path.posix.join('out', `${message.id}.jsonl`),
      codexSessionId: this.bindingFor(route.id),
    }
    await writeJsonAtomic(this.processingPath, processing).catch((error) => this.noteError(error))
    this.current = { messageId: message.id, routeId: route.id, phase: 'running', startedAt: processing.startedAt, attempt: 1 }
    this.currentPid = null
    this.currentPromise = this.executeMessage(message, route, outFile, cursorAfter, processing)
    try {
      await this.currentPromise
    } finally {
      this.current = null
      this.currentPromise = null
      this.abortController = null
      this.currentPid = null
    }
  }

  /**
   * Queue transport. Used for a thread owned by another Codex client (the
   * desktop app holds an exclusive writer). `codex queue` returns as soon as the
   * turn is enqueued, so the reply is read from the thread's rollout JSONL.
   */
  async callQueue(message, route, sessionId, signal) {
    if (!sessionId) {
      return { ok: false, errorCode: 'codex:thread-unknown', sawAnyEvent: false, completed: false }
    }
    try {
      return await this.queueRunner({
        executable: this.config.codexExecutable,
        threadId: sessionId,
        text: promptTextFor(message),
        marker: `id: ${message.id}`,
        codexHome: this.codexHome,
        timeoutMs: this.config.codexTimeoutMs,
        signal,
        onQueueAccepted: (queuedId) => {
          this.event('codex-queued', { messageId: message.id, queuedId, route: route.id })
        },
      })
    } catch (error) {
      return { ok: false, errorCode: error?.code ?? 'codex:queue-failed', sawAnyEvent: false, completed: false }
    }
  }

  async executeMessage(message, route, outFile, cursorAfter, processing) {
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      if (this.stopFile || this.disposed) {
        await this.patchProcessing(message.id, { phase: this.disposed ? 'running' : 'stopped', attempt })
        return
      }
      const controller = new AbortController()
      this.abortController = controller
      this.current = { messageId: message.id, routeId: route.id, phase: 'running', startedAt: processing.startedAt, attempt }
      // An operator bind may have landed mid-call; keep the target this
      // message started with, and never clobber the newer binding below.
      const sessionId = 'codexSessionId' in processing
        ? processing.codexSessionId
        : this.bindingFor(route.id)
      const args = buildArgs({
        sessionId,
        cwd: route.codexWorkingDirectory,
        outFile,
        model: route.model || this.config.model,
      })
      const transport = route.transport ?? this.config.transport ?? 'auto'
      this.event('codex-start', {
        messageId: message.id,
        status: `attempt-${attempt}`,
        route: route.id,
        transport,
      })
      let result
      if (transport === 'queue') {
        result = await this.callQueue(message, route, sessionId, controller.signal)
      } else {
        try {
          result = await this.runner({
            executable: this.config.codexExecutable,
            args,
            cwd: route.codexWorkingDirectory,
            stdinText: promptTextFor(message),
            timeoutMs: this.config.codexTimeoutMs,
            signal: controller.signal,
            outFile,
            maxReplyBytes: this.config.maxMessageBytes * 4,
            onSpawn: (pid) => {
              this.currentPid = pid
              this.event('codex-spawn', { messageId: message.id, pid })
              void this.writeState()
            },
          })
        } catch (error) {
          result = { ok: false, errorCode: error.code ?? 'codex:runner-failed', sawAnyEvent: false }
        }
        if (
          transport === 'auto' &&
          !result?.ok &&
          (result?.errorCode === 'codex:session-busy' || result?.stderrHint === 'codex:session-busy')
        ) {
          // `exec resume` cannot take a thread another process owns; the queue
          // transport can, and the answer is read from the rollout file.
          this.event('codex-queue-fallback', { messageId: message.id, route: route.id })
          result = await this.callQueue(message, route, sessionId, controller.signal)
        }
      }
      this.abortController = null

      if (result?.sessionId) {
        // Compare against the file, not memory: `ctl bind` may have landed
        // while this call was running, and that binding must win.
        const expected = 'codexSessionId' in processing
          ? processing.codexSessionId
          : this.bindingFor(route.id)
        const onDisk = await this.bindingOnDisk(route.id)
        if (onDisk === expected) {
          await this.recordSessionId(route.id, result.sessionId)
        } else {
          await this.syncRoutesFromDisk()
          this.event('binding-kept', { route: route.id, current: onDisk ?? null, ran: result.sessionId })
        }
      }

      if (result?.ok) {
        await this.clearRouteError(route.id)
        await this.completeMessage(message, result, cursorAfter)
        if (!this.bindingFor(route.id)) {
          this.routeStore.routes[route.id] = {
            codexSessionId: null,
            unavailableAt: new Date(this.now()).toISOString(),
          }
          await this.persistRoutes()
          this.applyDefaultMirrors()
          this.event('session-id-unavailable', { messageId: message.id })
        }
        return
      }

      const code = result?.errorCode ?? 'codex:failed'
      this.lastErrorCode = code
      if (this.disposed) {
        await this.patchProcessing(message.id, { phase: 'running', lastErrorCode: code, attempt })
        return
      }
      if (this.stopFile || result?.aborted) {
        await this.patchProcessing(message.id, { phase: 'stopped', lastErrorCode: code, attempt })
        return
      }
      if (result?.timedOut) {
        await this.uncertainMessage(message, result, cursorAfter, 'timeout')
        return
      }
      if (code === 'codex:session-lost' || result?.stderrHint === 'codex:session-lost') {
        await this.markSessionLost(route.id, message, result, cursorAfter)
        return
      }
      if (code === 'codex:reply-too-large') {
        await this.parkMessage(message, 'reply-too-large', cursorAfter, { detail: `reply ${result.replyBytes} bytes` })
        return
      }
      if (code === 'codex:auth-required' || code === 'codex:approval-required') {
        this.attention = { code, at: new Date(this.now()).toISOString(), messageId: message.id }
        this.event('needs-attention', { messageId: message.id, code })
        await this.parkMessage(message, 'needs-attention', cursorAfter, { detail: code })
        return
      }
      if (result?.completed && !result?.replyText) {
        await this.parkMessage(message, 'empty-reply', cursorAfter, { detail: code })
        return
      }
      if (result?.sawAnyEvent || result?.sessionId) {
        await this.uncertainMessage(message, result, cursorAfter, code)
        return
      }

      if (attempt >= this.config.maxAttempts) {
        await this.parkMessage(message, 'failed', cursorAfter, { detail: code, attempts: attempt })
        return
      }
      const backoff = Math.min(this.config.retryBaseMs * 2 ** (attempt - 1), 60000)
      await this.patchProcessing(message.id, {
        phase: 'retry-wait',
        attempt: attempt + 1,
        lastErrorCode: code,
      })
      this.event('codex-retry', { messageId: message.id, code, status: `attempt-${attempt + 1}-in-${backoff}ms` })
      await this.delay(backoff)
      if (this.disposed || this.stopFile) {
        await this.patchProcessing(message.id, {
          phase: this.disposed ? 'running' : 'stopped',
          attempt: attempt + 1,
          lastErrorCode: code,
        })
        return
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Completion, uncertainty, parking                                  */
  /* ---------------------------------------------------------------- */

  async readReply(messageId) {
    try {
      return await fsp.readFile(path.join(this.root, FILES.repliesDir, `${messageId}.txt`), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async readReplyMeta(messageId) {
    return readJsonFile(path.join(this.root, FILES.repliesDir, `${messageId}.json`), null)
  }

  async saveReply(messageId, text, meta) {
    const dir = path.join(this.root, FILES.repliesDir)
    await writeFileAtomic(path.join(dir, `${messageId}.txt`), text)
    await writeJsonAtomic(path.join(dir, `${messageId}.json`), meta)
  }

  async completeMessage(message, result, cursorAfter) {
    if (Buffer.byteLength(result.replyText, 'utf8') > this.config.maxMessageBytes) {
      await this.parkMessage(message, 'reply-too-large', cursorAfter, {
        detail: `reply ${Buffer.byteLength(result.replyText, 'utf8')} bytes exceeds maxMessageBytes`,
      })
      return
    }
    let meta = await this.readReplyMeta(message.id)
    if (!meta) {
      meta = {
        messageId: message.id,
        replyId: crypto.randomUUID(),
        replyTo: message.id,
        route: message.route ?? this.defaultRoute.id,
        hops: message.hops + 1,
        bytes: Buffer.byteLength(result.replyText, 'utf8'),
        savedAt: new Date(this.now()).toISOString(),
        codexSessionId: result.sessionId ?? this.bindingFor(message.route ?? this.defaultRoute.id),
        status: 'reply_saved',
      }
      await this.saveReply(message.id, result.replyText, meta)
    }
    await this.appendReplyAndFinish(message, meta, result.replyText, cursorAfter)
  }

  /**
   * Append the reply (unless an earlier attempt already did), record
   * completion, then advance the input cursor. Retrying after a crash is safe
   * because the reply id and replyTo are stable.
   */
  async appendReplyAndFinish(message, meta, replyText, cursorAfter) {
    if (!Number.isInteger(cursorAfter) || cursorAfter < 0) {
      await this.patchProcessing(message.id, { phase: 'reply_saved', lastErrorCode: 'state:cursor-missing' })
      this.addReason('state:cursor-missing', 'processing.json has no usable cursor; manual inspection required')
      this.event('reply-append-blocked', { messageId: message.id, code: 'state:cursor-missing' })
      return
    }

    let existing = null
    if (!meta.appendedAt) {
      existing = await findReplyTo(this.root, message.id, { maxBytes: this.config.maxMailboxBytes })
    }
    if (!existing) {
      const reply = {
        id: meta.replyId,
        at: new Date(this.now()).toISOString(),
        from: 'codex',
        to: 'dsh',
        kind: 'reply',
        text: replyText,
        hops: meta.hops,
        replyTo: message.id,
        route: meta.route ?? message.route ?? this.defaultRoute.id,
      }
      try {
        await appendJsonLine(this.root, FILES.inboxDsh, reply, {
          maxBytes: this.config.maxMailboxBytes,
          cursorFile: FILES.cursorDsh,
        })
        existing = reply
      } catch (error) {
        if (isMailboxError(error) && error.code === 'mailbox-full') {
          await this.patchProcessing(message.id, { phase: 'reply_saved' })
          this.nextCodexAt = this.now() + this.config.retryBaseMs
          this.event('reply-append-blocked', { messageId: message.id, code: 'mailbox-full' })
          this.log('warn', 'reply-append-blocked', { messageId: message.id, code: 'mailbox-full' })
          return
        }
        throw error
      }
    }

    const completed = {
      ...meta,
      status: 'completed',
      appendedAt: existing.at ?? new Date(this.now()).toISOString(),
      replyId: existing.id,
    }
    await writeJsonAtomic(path.join(this.root, FILES.repliesDir, `${message.id}.json`), completed)
    await writeCursor(this.root, FILES.cursorCodex, cursorAfter)
    this.cursorCodex = cursorAfter
    await fsp.unlink(this.processingPath).catch(() => {})
    this.lastErrorCode = null
    this.event('completed', {
      messageId: message.id,
      chars: replyText.length,
      status: `reply-${existing.id}`,
    })
    this.log('info', 'completed', { messageId: message.id, bytes: Buffer.byteLength(replyText, 'utf8') })
  }

  async uncertainMessage(message, result, cursorAfter, detail) {
    if (result?.replyText) {
      const existing = await this.readReplyMeta(message.id)
      if (!existing) {
        await this.saveReply(message.id, result.replyText, {
          messageId: message.id,
          replyId: crypto.randomUUID(),
          replyTo: message.id,
          route: message.route ?? this.defaultRoute.id,
          hops: message.hops + 1,
          bytes: Buffer.byteLength(result.replyText, 'utf8'),
          savedAt: new Date(this.now()).toISOString(),
          codexSessionId: result.sessionId ?? this.bindingFor(message.route ?? this.defaultRoute.id),
          status: 'delivery-uncertain',
        }).catch(() => {})
      }
    }
    await this.patchProcessing(message.id, { phase: 'uncertain', lastErrorCode: detail })
    await this.parkMessage(message, 'delivery-uncertain', cursorAfter, { detail, attempts: result?.events ?? 0 })
  }

  async parkMessage(message, code, cursorAfter, extra = {}) {
    const record = {
      at: new Date(this.now()).toISOString(),
      code,
      messageId: message.id,
      hops: message.hops ?? null,
      replyTo: message.replyTo ?? null,
      cursorAfter: Number.isInteger(cursorAfter) ? cursorAfter : null,
      detail: safeDetail(extra.detail) ?? null,
      message,
    }
    await this.patchProcessing(message.id, { phase: 'parked', parkCode: code, lastErrorCode: extra.detail ?? code })
    await this.appendParked(record)
    if (Number.isInteger(cursorAfter) && cursorAfter >= 0) {
      await writeCursor(this.root, FILES.cursorCodex, cursorAfter)
      this.cursorCodex = cursorAfter
    } else {
      this.addReason('state:cursor-missing', 'a parked message has no cursor; manual inspection required')
    }
    await fsp.unlink(this.processingPath).catch(() => {})
    this.metrics.parked += 1
    this.event('parked', { messageId: message.id, code, hops: message.hops ?? null })
    this.log('warn', 'parked', { messageId: message.id, code })
  }

  async parkRaw(file, raw, code, cursorAfter, detail) {
    const record = {
      at: new Date(this.now()).toISOString(),
      code,
      messageId: null,
      file,
      detail: safeDetail(detail) ?? null,
      raw: typeof raw === 'string' ? raw.slice(0, Math.min(this.config.maxMessageBytes, 8192)) : '',
      cursorAfter: Number.isInteger(cursorAfter) ? cursorAfter : null,
    }
    await this.appendParked(record)
    if (file === FILES.inboxDsh) {
      this.cursorDsh = cursorAfter
      await writeCursor(this.root, FILES.cursorDsh, cursorAfter)
    } else {
      this.cursorCodex = cursorAfter
      await writeCursor(this.root, FILES.cursorCodex, cursorAfter)
    }
    this.metrics.parked += 1
    this.event('parked', { code })
    this.log('warn', 'parked', { code })
  }

  async appendParked(record) {
    const parkedPath = path.join(this.root, FILES.parked)
    const size = await fileSize(parkedPath)
    if (size > 3.5 * 1024 * 1024) {
      await rotateMailbox(this.root, FILES.parked, { maxBytes: 4 * 1024 * 1024 }).catch(() => {})
    }
    try {
      await appendJsonLine(this.root, FILES.parked, record, { maxBytes: 4 * 1024 * 1024 })
    } catch (error) {
      if (isMailboxError(error) && error.code === 'mailbox-full') {
        await rotateMailbox(this.root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
        await appendJsonLine(this.root, FILES.parked, record, { maxBytes: 4 * 1024 * 1024 })
      } else {
        throw error
      }
    }
  }

  async patchProcessing(messageId, patch) {
    const current = await readJsonFile(this.processingPath, null)
    if (!current || current.messageId !== messageId) return
    await writeJsonAtomic(this.processingPath, { ...current, ...patch }).catch((error) => this.noteError(error))
  }

  /* ---------------------------------------------------------------- */
  /* Recovery                                                          */
  /* ---------------------------------------------------------------- */

  async recover() {
    const processing = await readJsonFile(this.processingPath, null)
    if (!processing || !processing.messageId) return
    this.event('recovery-found', { messageId: processing.messageId, status: processing.phase ?? 'unknown' })

    if (processing.phase === 'stopped') {
      this.stoppedPending = true
      return
    }

    if (processing.phase === 'parked' || processing.phase === 'uncertain') {
      const parked = await this.findParked(processing.messageId)
      if (!parked) {
        await this.appendParked({
          at: new Date(this.now()).toISOString(),
          code: processing.phase === 'uncertain' ? 'delivery-uncertain' : (processing.parkCode ?? 'parked-before-restart'),
          messageId: processing.messageId,
          hops: processing.hops ?? null,
          replyTo: processing.replyTo ?? null,
          cursorAfter: processing.cursorAfter ?? null,
          detail: 'recovered from processing.json',
        })
      }
      if (Number.isInteger(processing.cursorAfter)) {
        await writeCursor(this.root, FILES.cursorCodex, processing.cursorAfter)
        this.cursorCodex = processing.cursorAfter
      }
      await fsp.unlink(this.processingPath).catch(() => {})
      return
    }

    if (processing.phase === 'retry-wait') {
      // No Codex event had been observed when the retry wait was written, so
      // the cursor was deliberately left on this record: retrying is safe.
      await fsp.unlink(this.processingPath).catch(() => {})
      this.event('recovery-retry', { messageId: processing.messageId })
      return
    }

    const reply = await this.readReply(processing.messageId)
    const meta = await this.readReplyMeta(processing.messageId)
    if (reply !== null && meta?.status !== 'delivery-uncertain') {
      const message = {
        id: processing.messageId,
        hops: processing.hops ?? 1,
        replyTo: processing.replyTo ?? null,
        route: processing.routeId ?? this.defaultRoute.id,
      }
      if (!meta) {
        await this.saveReply(processing.messageId, reply, {
          messageId: processing.messageId,
          replyId: crypto.randomUUID(),
          replyTo: processing.messageId,
          route: message.route,
          hops: (processing.hops ?? 1) + 1,
          bytes: Buffer.byteLength(reply, 'utf8'),
          savedAt: new Date(this.now()).toISOString(),
          codexSessionId: processing.codexSessionId ?? this.bindingFor(message.route),
          status: 'reply_saved',
        })
      }
      const resolvedMeta = (await this.readReplyMeta(processing.messageId)) ?? meta
      await this.appendReplyAndFinish(message, resolvedMeta, reply, processing.cursorAfter)
      this.event('recovery-reused-reply', { messageId: processing.messageId })
      return
    }

    await this.parkMessage(
      {
        id: processing.messageId,
        hops: processing.hops ?? 1,
        replyTo: processing.replyTo ?? null,
        route: processing.routeId ?? this.defaultRoute.id,
      },
      'delivery-uncertain',
      processing.cursorAfter,
      { detail: 'process restarted after the Codex call started' },
    )
  }

  async resumePendingReply() {
    const processing = await readJsonFile(this.processingPath, null)
    if (!processing || processing.phase !== 'reply_saved') return false
    const reply = await this.readReply(processing.messageId)
    const meta = await this.readReplyMeta(processing.messageId)
    if (reply === null || !meta) return false
    const message = {
      id: processing.messageId,
      hops: processing.hops ?? 1,
      replyTo: processing.replyTo ?? null,
      route: processing.routeId ?? meta?.route ?? this.defaultRoute.id,
    }
    await this.appendReplyAndFinish(message, meta, reply, processing.cursorAfter)
    return true
  }

  async findParked(messageId) {
    const { records } = await readRecords(this.root, FILES.parked, { maxBytes: 4 * 1024 * 1024 })
    return records.find((record) => record?.messageId === messageId) ?? null
  }

  /* ---------------------------------------------------------------- */
  /* STOP                                                              */
  /* ---------------------------------------------------------------- */

  async handleStop() {
    if (this.stopLatched) return
    this.stopLatched = true
    this.event('stop-observed', {})
    this.log('warn', 'stop-observed', {})
    this.clearDelay()
    try {
      this.deliveryAbort?.abort()
    } catch {
      /* ignore */
    }
    if (this.current || this.currentPromise) {
      try {
        this.abortController?.abort()
      } catch {
        /* ignore */
      }
      await this.waitCurrent(Math.min(2000, this.config.shutdownTimeoutMs))
    }
    const processing = await readJsonFile(this.processingPath, null)
    if (processing?.messageId) {
      await this.patchProcessing(processing.messageId, {
        phase: 'stopped',
        stoppedAt: new Date(this.now()).toISOString(),
      })
      this.stoppedPending = true
    }
  }

  async resolveStopped() {
    const processing = await readJsonFile(this.processingPath, null)
    if (!processing?.messageId) {
      this.stoppedPending = false
      this.stopLatched = false
      return
    }
    const reply = await this.readReply(processing.messageId)
    const meta = await this.readReplyMeta(processing.messageId)
    if (reply !== null && meta?.status !== 'delivery-uncertain') {
      const message = {
        id: processing.messageId,
        hops: processing.hops ?? 1,
        replyTo: processing.replyTo ?? null,
        route: processing.routeId ?? this.defaultRoute.id,
      }
      await this.appendReplyAndFinish(message, meta ?? {
        messageId: processing.messageId,
        replyId: crypto.randomUUID(),
        replyTo: processing.messageId,
        route: message.route,
        hops: (processing.hops ?? 1) + 1,
        status: 'reply_saved',
      }, reply, processing.cursorAfter)
    } else {
      await this.parkMessage(
        {
          id: processing.messageId,
          hops: processing.hops ?? 1,
          replyTo: processing.replyTo ?? null,
          route: processing.routeId ?? this.defaultRoute.id,
        },
        'delivery-uncertain',
        processing.cursorAfter,
        { detail: 'STOP while a Codex call was in flight' },
      )
    }
    this.stoppedPending = false
    this.stopLatched = false
    this.event('stop-resolved', {})
  }

  /* ---------------------------------------------------------------- */
  /* Public operations                                                 */
  /* ---------------------------------------------------------------- */

  async send(text, options = {}) {
    const replyTo = options.replyTo ?? null
    if (options.signal?.aborted) return { status: 'error', code: 'cancelled' }
    if (this.disposed) return { status: 'error', code: 'disposed' }
    if (!this.lockOwned) return { status: 'error', code: this.configOk ? 'not-locked' : 'not-ready', reasons: this.reasonCodes() }
    if (!this.configOk) return { status: 'error', code: 'not-ready', reasons: this.reasonCodes() }
    if (typeof text !== 'string' || text.trim() === '') return { status: 'error', code: 'empty-text' }
    if (Buffer.byteLength(text, 'utf8') > this.config.maxMessageBytes) {
      return { status: 'error', code: 'message-too-large', maxMessageBytes: this.config.maxMessageBytes }
    }
    if (await pathExists(this.stopPath)) return { status: 'rejected', code: 'stop' }
    if (!this.ready) return { status: 'error', code: 'not-ready', reasons: this.reasonCodes() }
    await this.syncRoutesFromDisk()

    let hops = 1
    let route = null
    const caller = options.caller ?? null
    if (options.route) {
      route = findRoute(this.config, options.route)
      if (!route) return { status: 'error', code: 'route-unknown', route: options.route }
    } else if (caller) {
      const owned = this.config.routes.filter((item) => item.dshSessionId === caller)
      if (owned.length === 1) route = owned[0]
      else if (owned.length === 0) return { status: 'error', code: 'route-forbidden' }
      else if (this.config.routes.length > 1) return { status: 'error', code: 'route-required' }
    }
    if (caller && route && route.dshSessionId !== caller) {
      return { status: 'error', code: 'route-forbidden', route: route.id }
    }
    if (replyTo !== null) {
      if (!isUuid(replyTo)) return { status: 'error', code: 'invalid-reply-to' }
      const parent = await findMessage(this.root, replyTo, { maxBytes: this.config.maxMailboxBytes })
      if (!parent) return { status: 'error', code: 'unknown-reply-to' }
      const parentRoute = parent.route ?? this.defaultRoute.id
      if (route && route.id !== parentRoute) {
        return { status: 'error', code: 'route-mismatch', route: route.id, parentRoute }
      }
      route = route ?? findRoute(this.config, parentRoute)
      if (!route) return { status: 'error', code: 'route-unknown', route: parentRoute }
      if (caller && route.dshSessionId !== caller) {
        return { status: 'error', code: 'route-forbidden', route: route.id }
      }
      hops = (Number.isInteger(parent.hops) ? parent.hops : 0) + 1
    }
    if (!route) {
      if (this.config.routes.length !== 1) return { status: 'error', code: 'route-required' }
      route = this.defaultRoute
    }
    if (this.routeIsLost(route.id)) {
      return { status: 'error', code: 'route-session-lost', route: route.id }
    }
    if (hops >= this.config.maxHops) {
      return { status: 'rejected', code: 'hop-limit', hops, maxHops: this.config.maxHops }
    }

    const depth = await countPendingLines(this.root, FILES.inboxCodex, this.cursorCodex, {
      limit: this.config.maxQueueDepth + 1,
    })
    if (depth + 1 > this.config.maxQueueDepth) {
      return { status: 'busy', code: 'queue-full', queueDepth: depth, maxQueueDepth: this.config.maxQueueDepth }
    }

    const message = makeMessage({ from: 'dsh', to: 'codex', text, hops, replyTo, route: route.id })
    try {
      await appendJsonLine(this.root, FILES.inboxCodex, message, {
        maxBytes: this.config.maxMailboxBytes,
        cursorFile: FILES.cursorCodex,
      })
    } catch (error) {
      if (isMailboxError(error) && (error.code === 'mailbox-full' || error.code === 'append-lock-timeout')) {
        return { status: 'busy', code: error.code }
      }
      throw error
    }
    this.metrics.depthCodex = depth + 1
    this.event('queued', { messageId: message.id, chars: text.length, hops })
    this.log('info', 'queued', { messageId: message.id, chars: text.length, hops })
    this.schedule(0)
    return { status: 'queued', id: message.id, hops, route: route.id, queueDepth: depth + 1 }
  }

  snapshot() {
    const lock = this.lockOwned ? 'owned' : this.lockState
    return {
      version: BRIDGE_VERSION,
      instance: {
        id: this.instanceId,
        pid: process.pid,
        startedAt: this.startedAt,
        ready: this.ready,
        reasons: [...this.reasons.values()],
        lock,
        lockedBy: this.lockOwner
          ? { pid: this.lockOwner.pid ?? null, instanceId: this.lockOwner.instanceId ?? null, startedAt: this.lockOwner.startedAt ?? null }
          : null,
      },
      dsh: {
        sessionId: this.config.dshSessionId,
        sessionReady: this.dshSessionReady,
      },
      routes: this.config.routes.map((route) => ({
        id: route.id,
        dshSessionId: route.dshSessionId,
        dshReady: this.routeDshReady.get(route.id) ?? null,
        codexSessionId: this.bindingFor(route.id),
        sessionLost: this.routeIsLost(route.id),
        sessionIdUnavailable: this.routeIsUnavailable(route.id),
        workingDirectory: route.codexWorkingDirectory,
        transport: route.transport,
      })),
      codex: {
        executable: this.config.codexExecutable,
        workingDirectory: this.config.codexWorkingDirectory,
        version: this.codexStatus?.version ?? null,
        ready: this.codexReady,
        sessionId: this.sessionId,
        sessionLost: this.sessionLost,
        sessionIdUnavailable: this.sessionIdUnavailable,
        model: this.config.model || null,
        sandbox: 'workspace-write',
      },
      current: this.current
        ? {
            messageId: this.current.messageId,
            phase: this.current.phase,
            attempt: this.current.attempt,
            startedAt: this.current.startedAt,
            pid: this.currentPid,
          }
        : null,
      queue: {
        dshToCodex: this.metrics.depthCodex,
        codexToDsh: this.metrics.depthDsh,
      },
      parked: this.metrics.parked,
      stop: this.stopFile,
      attention: this.attention,
      lastErrorCode: this.lastErrorCode,
      delivery: {
        source: this.config.deliverySource,
        mode: this.config.deliveryMode,
      },
      limits: {
        maxHops: this.config.maxHops,
        maxAttempts: this.config.maxAttempts,
        maxQueueDepth: this.config.maxQueueDepth,
        maxMessageBytes: this.config.maxMessageBytes,
        maxMailboxBytes: this.config.maxMailboxBytes,
        codexTimeoutMs: this.config.codexTimeoutMs,
      },
      updatedAt: new Date(this.now()).toISOString(),
    }
  }

  async writeState(force = false) {
    if (!this.lockOwned || this.disposed) return
    const snapshot = this.snapshot()
    const { updatedAt, ...stable } = snapshot
    const hash = JSON.stringify(stable)
    const now = this.now()
    if (!force && hash === this.stateHash) return
    if (!force && now - this.lastStateWrite < STATE_MIN_INTERVAL_MS && this.wroteState) return
    this.stateHash = hash
    this.lastStateWrite = now
    this.wroteState = true
    try {
      await writeJsonAtomic(path.join(this.root, FILES.state), snapshot)
    } catch (error) {
      this.lastErrorCode = error.code ?? 'state-write-failed'
    }
  }

  async event(name, fields = {}) {
    if (!this.lockOwned) return
    const record = { at: new Date(this.now()).toISOString(), event: name }
    if (fields.messageId) record.messageId = fields.messageId
    if (Number.isFinite(fields.chars)) record.chars = fields.chars
    if (fields.status) record.status = String(fields.status).slice(0, 120)
    if (fields.code) record.code = String(fields.code).slice(0, 120)
    if (Number.isInteger(fields.pid)) record.pid = fields.pid
    if (Number.isInteger(fields.hops)) record.hops = fields.hops
    if (fields.route) record.route = String(fields.route).slice(0, 40)
    if (fields.transport) record.transport = String(fields.transport).slice(0, 12)
    if (fields.queuedId) record.queuedId = String(fields.queuedId).slice(0, 60)
    try {
      await appendEvent(this.root, record)
    } catch {
      /* logging must never break delivery */
    }
  }

  noteError(error) {
    const code = error?.code ?? 'internal'
    this.lastErrorCode = code
    this.log('error', 'internal-error', { code })
    void this.event('error', { code })
  }

  log(level, event, fields = {}) {
    const target = this.logger?.[level]
    if (typeof target !== 'function') return
    try {
      target.call(this.logger, `[codex-bridge] ${event}`, fields)
    } catch {
      /* ignore */
    }
  }

  async installHelper() {
    if (!this.helperSource) return
    try {
      const source = await fsp.readFile(this.helperSource, 'utf8')
      const toolsDir = path.join(this.root, FILES.toolsDir)
      const dest = path.join(toolsDir, 'send.mjs')
      const ctlDest = path.join(toolsDir, 'ctl.mjs')
      await fsp.mkdir(path.join(toolsDir, 'lib'), { recursive: true })

      const manifest = await fsp.readFile(path.join(toolsDir, 'package.json'), 'utf8').catch(() => null)
      if (manifest !== '{\n  "type": "module"\n}\n') {
        await writeFileAtomic(path.join(toolsDir, 'package.json'), '{\n  "type": "module"\n}\n')
      }

      // The helpers are executed from inside the Codex workspace, so they carry
      // their own copies of the shared protocol and mailbox code.
      for (const name of ['mailbox.js', 'protocol.js']) {
        const libSource = await fsp.readFile(new URL(`./${name}`, import.meta.url), 'utf8')
        await writeFileAtomic(path.join(toolsDir, 'lib', name), libSource)
      }

      let copied = false
      for (const [file, contents] of [
        [dest, source],
        [ctlDest, await fsp.readFile(path.join(path.dirname(this.helperSource), 'ctl.mjs'), 'utf8')],
      ]) {
        let current = null
        try {
          current = await fsp.readFile(file, 'utf8')
        } catch {
          /* missing */
        }
        if (current !== contents) {
          await writeFileAtomic(file, contents)
          copied = true
        }
      }
      if (copied) this.event('helper-installed', {})
    } catch (error) {
      this.log('warn', 'helper-install-failed', { code: error.code ?? 'write-failed' })
    }
  }
}

export { readInstanceLock, isProcessAlive, MailboxError }
