/**
 * The HTTP layer.
 *
 * It carries requests, validates their shape and names refusals. It holds no
 * accounting rule of its own: every route is a call into `Ledger`, which is a
 * call into the schema, which is where the rules live.
 *
 * The tenant arrives in a header and is set on the connection by
 * `Database.asTenant` for the duration of one transaction, so a request that
 * reaches for another tenant's rows does not get filtered out by a WHERE
 * clause written here -- the rows are not visible to it at all, and a request
 * with no tenant at all sees nothing rather than everything.
 */

import { randomUUID } from 'node:crypto'

import Fastify from 'fastify'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'

import type { Database } from '../database.js'
import { Ledger } from '../ledger.js'
import { ApiError, describeError, errorBody } from './errors.js'
import { registerRoutes } from './routes.js'
import { validateTenantHeader } from './validation.js'

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string
  }
}

const TENANT_HEADER = 'x-tenant-id'

export interface ServerOptions {
  logger?: FastifyServerOptions['logger']
  /** Rejects a body larger than this before it is parsed. Default 1 MiB. */
  bodyLimit?: number
}

export function buildServer(db: Database, options: ServerOptions = {}): FastifyInstance {
  const ledger = new Ledger(db)

  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error, request, reply) => {
    const described = describeError(error)

    // A 4xx is the caller's mistake and its stack trace is this file, so only
    // the outcome is logged. A 5xx is ours and gets everything.
    if (described.status >= 500) {
      request.log.error({ err: error }, 'request failed')
    } else {
      request.log.warn(
        { code: described.code, status: described.status, reason: described.message },
        'request refused',
      )
    }

    reply.status(described.status).send(errorBody(described, request.id))
  })

  // Thrown rather than answered here, so that a missing route leaves through
  // the same handler as every other refusal and arrives in the same shape.
  app.setNotFoundHandler(async (request) => {
    throw new ApiError(404, 'route_not_found', `no route for ${request.method} ${request.url}`)
  })

  app.get('/health', async (request, reply) => {
    try {
      const row = await db.admin((session) =>
        session.one<{ count: number }>(
          'select count(*)::int as count from ledger.schema_migrations',
        ),
      )
      return { status: 'ok', migrations: Number(row.count) }
    } catch (error) {
      request.log.error({ err: error }, 'health check failed')
      reply.status(503)
      return { status: 'unavailable' }
    }
  })

  app.register(
    async (scope) => {
      scope.decorateRequest('tenantId', '')

      scope.addHook('onRequest', async (request) => {
        const tenantId = validateTenantHeader(request.headers[TENANT_HEADER])

        // A tenant id that names nothing would otherwise read as a tenant with
        // empty books -- the fail-closed default of the row security policies.
        // Turning that into a 404 costs one indexed lookup per request and
        // stops a typo from looking like a fresh set of books.
        if ((await ledger.getTenant(tenantId)) === undefined) {
          throw new ApiError(404, 'tenant_not_found', `no tenant ${tenantId}`)
        }

        request.tenantId = tenantId
        request.log = request.log.child({ tenantId })
      })

      registerRoutes(scope, ledger)
    },
    { prefix: '/v1' },
  )

  return app
}
