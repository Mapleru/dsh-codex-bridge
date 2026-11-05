/**
 * dsh-codex-bridge — host plugin.
 *
 * Bridges one or more DSH sessions to dedicated Codex CLI threads through a
 * local file mailbox. Routes are selected by session id on both sides; a
 * message that names no route is only accepted when exactly one route exists.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from './lib/bridge.js'
import { normalizeConfig } from './lib/config.js'
import { promptRequestId, promptTextFor } from './lib/protocol.js'
import { registerSkill } from './lib/skill.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function lazySessionController(ctx) {
  return () => {
    try {
      return ctx.get('sessionController')
    } catch {
      return undefined
    }
  }
}

function errorCode(error) {
  if (!error || typeof error !== 'object') return 'delivery-failed'
  if (typeof error.code === 'string') return error.code
  const nested = error.error
  if (nested && typeof nested.code === 'string') return nested.code
  return 'delivery-failed'
}

// `tools` is required for registration; `skills` is injected inside apply so a
// missing skill service only disables the skill, not the whole bridge.
export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('codex-bridge') : console
  const controller = lazySessionController(ctx)
  const routeSessions = new Set(config.routes.map((route) => route.dshSessionId))

  const sessions = () => {
    const service = controller()
    if (!service) throw Object.assign(new Error('sessionController service is not available'), { code: 'service-missing' })
    return service
  }

  /**
   * Deliver one Codex message into a route's DSH session.
   *
   * `webhook` uses a direct agent call with a webhook source, so the message is
   * rendered as external input rather than as if the operator typed it. That
   * path has no requestId dedupe; the bridge keeps its own delivered ledger.
   * `user` keeps the old prompt() path for exact-once acceptance when needed.
   */
  const deliver = async (message, options = {}) => {
    const route = options.route
    if (!route) return { accepted: false, error: { code: 'route-required' } }

    let service
    try {
      service = sessions()
    } catch (error) {
      return { accepted: false, error: { code: errorCode(error) } }
    }

    let resolved
    try {
      resolved = await service.resolveAgent(route.dshSessionId)
    } catch (error) {
      return { accepted: false, error: { code: errorCode(error) } }
    }
    if (!resolved || !resolved.agent) {
      return { accepted: false, error: { code: resolved?.error?.code ?? 'session/not-found' } }
    }

    const text = promptTextFor(message)

    if (config.deliverySource === 'webhook') {
      const agent = resolved.agent
      // `followup` queues the message for the next turn so a long-running turn is
      // not interrupted; `steer` delivers immediately (and starts a new turn).
      // Fall back to whichever method the Agent build actually exposes.
      const preferred = config.deliveryMode === 'steer' ? 'steer' : 'followup'
      const fallback = preferred === 'steer' ? 'followup' : 'steer'
      const method = typeof agent[preferred] === 'function' ? preferred : fallback
      const call = agent[method]
      if (typeof call !== 'function') {
        return { accepted: false, error: { code: 'delivery-unsupported' } }
      }
      try {
        await call.call(agent, {
          id: crypto.randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: {
            kind: 'webhook',
            provider: 'codex-bridge',
            source: 'codex-bridge',
            deliveryId: message.id,
            ruleId: 'codex-bridge',
            form: 'notice',
            summary: 'Codex bridge message',
          },
        })
        return { accepted: true }
      } catch (error) {
        return { accepted: false, error: { code: errorCode(error) } }
      }
    }

    try {
      const result = await service.prompt(
        {
          requestId: promptRequestId(message.id),
          sessionId: route.dshSessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: 'Asia/Shanghai',
        },
        options.signal ?? new AbortController().signal,
      )
      if (result && result.error) {
        return { accepted: false, error: { code: result.error.code ?? 'prompt-failed' } }
      }
      return { accepted: true }
    } catch (error) {
      return { accepted: false, error: { code: errorCode(error) } }
    }
  }

  const probeSession = async () => {
    const routes = []
    for (const route of config.routes) {
      try {
        const resolved = await sessions().resolveAgent(route.dshSessionId)
        if (resolved && resolved.agent) routes.push({ id: route.id, ok: true })
        else routes.push({ id: route.id, ok: false, code: resolved?.error?.code ?? 'session/not-found' })
      } catch (error) {
        routes.push({ id: route.id, ok: false, code: errorCode(error) })
      }
    }
    const failed = routes.filter((item) => !item.ok)
    return {
      ok: failed.length < routes.length,
      code: failed[0]?.code ?? null,
      routes,
    }
  }

  const bridge = new Bridge({
    config,
    deliver,
    probeSession,
    helperSource: path.join(HERE, 'tools', 'send.mjs'),
    logger,
  })

  const anyRouteSession = ({ agent }) => routeSessions.has(agent?.id)

  ctx.effect(() => {
    const disposers = []
    disposers.push(
      ctx.tools.register(
        {
          name: 'codex_bridge_send',
          description:
            'Send an explicit message to a dedicated Codex CLI collaboration thread through the local file mailbox. ' +
            'Use this only when you want Codex to act or answer. Normal text answers are not forwarded automatically. ' +
            'Pass replyTo with a Codex message id to answer it (hops increase by one, and the reply stays on the parent route). ' +
            'When this session owns more than one route, pass route explicitly.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Message body to deliver to Codex.' },
              replyTo: {
                type: 'string',
                description: 'Optional id of the Codex message this answers. Must be a known message id.',
              },
              route: {
                type: 'string',
                description: 'Optional route id. Defaults to the single route owned by this DSH session.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                id: { type: 'string' },
                hops: { type: 'integer' },
                route: { type: 'string' },
                queueDepth: { type: 'integer' },
                code: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['status'],
              additionalProperties: true,
            },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2) },
            ],
          },
          execute: async (args, exec) =>
            bridge.send(args?.text, {
              replyTo: args?.replyTo ?? null,
              route: args?.route ?? null,
              caller: exec?.agent?.id ?? null,
            }),
        },
        { when: anyRouteSession },
      ),
    )
    disposers.push(
      ctx.tools.register(
        {
          name: 'codex_bridge_status',
          description:
            'Report Codex bridge readiness, every configured route (DSH session, Codex thread, health), queue depth, ' +
            'current message, parked count, STOP state and the last error code.',
          parameters: {
            type: 'object',
            properties: {
              route: { type: 'string', description: 'Optional route id to report alone.' },
            },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2) },
            ],
          },
          execute: async (args) => {
            const snapshot = bridge.snapshot()
            if (!args?.route) return snapshot
            const route = snapshot.routes.find((item) => item.id === args.route)
            return { ...snapshot, routes: route ? [route] : [], selectedRoute: args.route }
          },
        },
        { when: anyRouteSession },
      ),
    )
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  })

  ctx.effect(() => {
    const dispose = registerSkill(ctx, path.join(HERE, 'skills', 'codex-bridge', 'SKILL.md'), logger)
    return () => dispose?.()
  })

  ctx.effect(() => () => bridge.stop())

  bridge.start().catch((error) => {
    logger?.error?.('codex-bridge start failed', { code: errorCode(error) })
  })

  return bridge
}

export { Bridge } from './lib/bridge.js'
