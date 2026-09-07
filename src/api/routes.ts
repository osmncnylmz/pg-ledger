import type { FastifyInstance } from 'fastify'

import { AccountNotFoundError } from '../errors.js'
import type { Ledger } from '../ledger.js'
import type { JournalEntryWithLines, Uuid } from '../types.js'
import { ApiError } from './errors.js'
import {
  encodeCursor,
  parseAsOfQuery,
  parseListQuery,
  parsePostEntry,
  parseRangeQuery,
  parseReversal,
  validateUuid,
} from './validation.js'

async function requireEntry(
  ledger: Ledger,
  tenantId: Uuid,
  entryId: Uuid,
): Promise<JournalEntryWithLines> {
  const entry = await ledger.getEntry(tenantId, entryId)
  if (entry === undefined) {
    // Row level security is what makes this correct for another tenant's
    // entry id: the row is not hidden by a filter written here, it is not
    // visible to the connection at all.
    throw new ApiError(404, 'entry_not_found', `no entry ${entryId} in this tenant`)
  }
  return entry
}

export function registerRoutes(app: FastifyInstance, ledger: Ledger): void {
  app.post('/entries', async (request, reply) => {
    const body = parsePostEntry(request.body)
    const { entryId, created } = await ledger.postEntry({ tenantId: request.tenantId, ...body })
    const entry = await requireEntry(ledger, request.tenantId, entryId)

    // A replay is a 200 over the entry that already exists; only the call that
    // actually wrote the journal gets a 201 and a Location.
    if (created) {
      reply.code(201).header('location', `/v1/entries/${entryId}`)
    }
    return entry
  })

  app.get('/entries', async (request) => {
    const query = parseListQuery(request.query)

    // One row past the page tells us whether a next page exists without a
    // second count query.
    const rows = await ledger.listEntries(request.tenantId, {
      limit: query.limit + 1,
      ...(query.before === undefined ? {} : { before: query.before }),
    })

    const entries = rows.slice(0, query.limit)
    const last = entries.at(-1)
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ postedAt: last.postedAt.toISOString(), id: last.id })
        : null

    return { entries, nextCursor }
  })

  app.get('/entries/:entryId', async (request) => {
    const { entryId } = request.params as { entryId: string }
    return requireEntry(ledger, request.tenantId, validateUuid('entryId', entryId))
  })

  app.post('/entries/:entryId/reversal', async (request, reply) => {
    const { entryId } = request.params as { entryId: string }
    const body = parseReversal(request.body)

    const reversalId = await ledger.reverseEntry({
      tenantId: request.tenantId,
      entryId: validateUuid('entryId', entryId),
      ...body,
    })

    reply.code(201).header('location', `/v1/entries/${reversalId}`)
    return requireEntry(ledger, request.tenantId, reversalId)
  })

  app.get('/accounts', async (request) => {
    return { accounts: await ledger.listAccounts(request.tenantId) }
  })

  app.get('/accounts/:code/statement', async (request) => {
    const { code } = request.params as { code: string }
    const range = parseRangeQuery(request.query)

    try {
      return { accountCode: code, rows: await ledger.statement(request.tenantId, code, range) }
    } catch (error) {
      // The same refusal is a 422 when the account code arrives in a posting
      // and a 404 here, where it is the resource the URL names.
      if (error instanceof AccountNotFoundError) {
        throw new ApiError(404, 'account_not_found', `no account ${code} in this chart of accounts`)
      }
      throw error
    }
  })

  app.get('/reports/trial-balance', async (request) => {
    const asOf = parseAsOfQuery(request.query) ?? new Date().toISOString()
    return { asOf, rows: await ledger.trialBalance(request.tenantId, asOf) }
  })
}
