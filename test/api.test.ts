/**
 * The HTTP layer, driven through Fastify's `inject` so no port is bound.
 *
 * Behind the routes is a real PGlite with the real migrations, the same as
 * every other test file here: the 422s below are the database refusing, not a
 * mock, and the cross-tenant 404s are row level security, not a WHERE clause.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Response as InjectResponse } from 'light-my-request'

import { buildServer } from '../src/api/server.js'
import type { Database } from '../src/database.js'
import type { Ledger } from '../src/ledger.js'
import { CHART_OF_ACCOUNTS, createFixture, seedTenant } from './helpers.js'

interface Issue {
  path: string
  message: string
}

interface ErrorResponse {
  error: { code: string; message: string; detail?: string; issues?: Issue[] }
  requestId: string
}

interface EntryResponse {
  id: string
  tenantId: string
  idempotencyKey: string
  postedAt: string
  description: string
  currency: string
  reversesEntryId: string | null
  reversedByEntryId: string | null
  isReversed: boolean
  lines: { lineNo: number; accountCode: string; direction: string; amount: string }[]
}

function json<T>(response: InjectResponse): T {
  return JSON.parse(response.body) as T
}

let db: Database
let ledger: Ledger
let app: FastifyInstance
let acme: string
let rival: string

/** A balanced entry, unique per idempotency key unless told otherwise. */
function entry(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: key,
    postedAt: '2026-03-01T09:00:00Z',
    description: `Invoice ${key}`,
    currency: 'EUR',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '20000.0000' },
      { accountCode: '4000', direction: 'credit', amount: '20000.0000' },
    ],
    ...overrides,
  }
}

function post(tenantId: string, body: Record<string, unknown>): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/entries',
    headers: { 'x-tenant-id': tenantId },
    payload: body,
  })
}

function get(tenantId: string, url: string): Promise<InjectResponse> {
  return app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenantId } })
}

beforeAll(async () => {
  const fixture = await createFixture()
  db = fixture.db
  ledger = fixture.ledger

  acme = (await seedTenant(ledger, { slug: 'acme' })).id
  rival = (await seedTenant(ledger, { slug: 'rival' })).id

  app = buildServer(db, { logger: false })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.close()
})

describe('health', () => {
  it('reports the applied migration count, which means it really asked the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(json<{ status: string; migrations: number }>(response).migrations).toBeGreaterThan(10)
  })

  it('needs no tenant header', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })
})

describe('tenant context', () => {
  it('refuses a request with no tenant header', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/accounts' })

    expect(response.statusCode).toBe(400)
    const body = json<ErrorResponse>(response)
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.issues?.[0]?.path).toBe('X-Tenant-Id')
  })

  it('refuses a tenant header that is not a uuid', async () => {
    const response = await get('not-a-uuid', '/v1/accounts')
    expect(response.statusCode).toBe(400)
    expect(json<ErrorResponse>(response).error.issues?.[0]?.message).toContain('UUID')
  })

  it('refuses a tenant that does not exist rather than showing empty books', async () => {
    const response = await get('00000000-0000-4000-8000-000000000000', '/v1/accounts')
    expect(response.statusCode).toBe(404)
    expect(json<ErrorResponse>(response).error.code).toBe('tenant_not_found')
  })

  it('does not show one tenant the entry another tenant posted', async () => {
    const posted = await post(acme, entry('isolation-1'))
    const { id } = json<EntryResponse>(posted)

    expect((await get(acme, `/v1/entries/${id}`)).statusCode).toBe(200)

    const stolen = await get(rival, `/v1/entries/${id}`)
    expect(stolen.statusCode).toBe(404)
    expect(json<ErrorResponse>(stolen).error.code).toBe('entry_not_found')
  })

  it("does not leak another tenant's postings into a list, a statement or a report", async () => {
    const entries = json<{ entries: EntryResponse[] }>(await get(rival, '/v1/entries'))
    expect(entries.entries).toHaveLength(0)

    const statement = json<{ rows: unknown[] }>(await get(rival, '/v1/accounts/1000/statement'))
    expect(statement.rows).toHaveLength(0)

    const trial = json<{ rows: unknown[] }>(await get(rival, '/v1/reports/trial-balance'))
    expect(trial.rows).toHaveLength(0)
  })

  it('refuses to post to an account code that belongs to another chart of accounts', async () => {
    const other = await seedTenant(ledger, {
      slug: 'narrow',
      accounts: [
        { code: '9', name: 'Assets', type: 'asset' },
        { code: '9000', name: 'Cash', type: 'asset', parentCode: '9' },
      ],
    })

    const response = await post(other.id, entry('cross-tenant-codes'))
    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('account_not_found')
  })
})

describe('posting', () => {
  it('creates an entry, answers 201 and points at it', async () => {
    const response = await post(acme, entry('invoice-001'))

    expect(response.statusCode).toBe(201)
    const body = json<EntryResponse>(response)
    expect(response.headers.location).toBe(`/v1/entries/${body.id}`)
    expect(body.description).toBe('Invoice invoice-001')
    expect(body.lines.map((line) => [line.accountCode, line.direction, line.amount])).toEqual([
      ['1000', 'debit', '20000.0000'],
      ['4000', 'credit', '20000.0000'],
    ])
  })

  it('returns the original entry with 200 when the idempotency key is replayed', async () => {
    const first = await post(acme, entry('invoice-replay'))
    const second = await post(acme, entry('invoice-replay'))

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.headers.location).toBeUndefined()
    expect(json<EntryResponse>(second)).toEqual(json<EntryResponse>(first))
  })

  it('ignores the payload of a replay, because the first write is the entry', async () => {
    await post(acme, entry('invoice-replay-2'))
    const replay = await post(
      acme,
      entry('invoice-replay-2', { description: 'a different description' }),
    )

    expect(replay.statusCode).toBe(200)
    expect(json<EntryResponse>(replay).description).toBe('Invoice invoice-replay-2')
  })

  it('fetches a posted entry with its lines', async () => {
    const { id } = json<EntryResponse>(await post(acme, entry('invoice-fetch')))
    const response = await get(acme, `/v1/entries/${id}`)

    expect(response.statusCode).toBe(200)
    expect(json<EntryResponse>(response).lines).toHaveLength(2)
  })
})

describe('reversal', () => {
  it('posts the mirror entry and links the two', async () => {
    const original = json<EntryResponse>(await post(acme, entry('to-reverse')))

    const response = await app.inject({
      method: 'POST',
      url: `/v1/entries/${original.id}/reversal`,
      headers: { 'x-tenant-id': acme },
      payload: { description: 'Credit note' },
    })

    expect(response.statusCode).toBe(201)
    const reversal = json<EntryResponse>(response)
    expect(reversal.reversesEntryId).toBe(original.id)
    expect(reversal.lines.map((line) => line.direction)).toEqual(['credit', 'debit'])

    const refetched = json<EntryResponse>(await get(acme, `/v1/entries/${original.id}`))
    expect(refetched.isReversed).toBe(true)
    expect(refetched.reversedByEntryId).toBe(reversal.id)
  })

  it('refuses a second reversal of the same entry', async () => {
    const original = json<EntryResponse>(await post(acme, entry('reverse-twice')))
    const url = `/v1/entries/${original.id}/reversal`

    await app.inject({ method: 'POST', url, headers: { 'x-tenant-id': acme } })
    const second = await app.inject({ method: 'POST', url, headers: { 'x-tenant-id': acme } })

    expect(second.statusCode).toBe(409)
    expect(json<ErrorResponse>(second).error.code).toBe('already_reversed')
  })

  it('refuses an idempotency key that already belongs to another entry', async () => {
    const original = json<EntryResponse>(await post(acme, entry('reverse-dup-key')))
    await post(acme, entry('taken-key'))

    const response = await app.inject({
      method: 'POST',
      url: `/v1/entries/${original.id}/reversal`,
      headers: { 'x-tenant-id': acme },
      payload: { idempotencyKey: 'taken-key' },
    })

    expect(response.statusCode).toBe(409)
    expect(json<ErrorResponse>(response).error.code).toBe('duplicate_idempotency_key')
  })

  it('reports an unknown entry as 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entries/11111111-1111-4111-8111-111111111111/reversal',
      headers: { 'x-tenant-id': acme },
    })

    expect(response.statusCode).toBe(404)
    expect(json<ErrorResponse>(response).error.code).toBe('entry_not_found')
  })
})

describe('validation', () => {
  it('rejects a fractional JSON number, which has already lost precision', async () => {
    const response = await post(
      acme,
      entry('float-amount', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: 20000.1 },
          { accountCode: '4000', direction: 'credit', amount: 20000.1 },
        ],
      }),
    )

    expect(response.statusCode).toBe(400)
    const body = json<ErrorResponse>(response)
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.issues?.map((issue) => issue.path)).toEqual([
      'lines.0.amount',
      'lines.1.amount',
    ])
    expect(body.error.issues?.[0]?.message).toContain('precision')
  })

  it('rejects a decimal string finer than numeric(20,4)', async () => {
    const response = await post(
      acme,
      entry('too-precise', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '1.00001' },
          { accountCode: '4000', direction: 'credit', amount: '1.00001' },
        ],
      }),
    )

    expect(response.statusCode).toBe(400)
    expect(json<ErrorResponse>(response).error.issues?.[0]?.path).toBe('lines.0.amount')
  })

  it('accepts a whole-number amount as an integer', async () => {
    const response = await post(
      acme,
      entry('integer-amount', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: 750 },
          { accountCode: '4000', direction: 'credit', amount: 750 },
        ],
      }),
    )

    expect(response.statusCode).toBe(201)
    expect(json<EntryResponse>(response).lines[0]?.amount).toBe('750.0000')
  })

  it('reports every problem with a request at once', async () => {
    const response = await post(acme, {
      idempotencyKey: '  ',
      postedAt: 'last Tuesday',
      currency: 'euro',
      lines: [{ accountCode: '1000', direction: 'sideways', amount: '10.00' }],
    })

    expect(response.statusCode).toBe(400)
    const paths = json<ErrorResponse>(response).error.issues?.map((issue) => issue.path)
    expect(paths).toEqual([
      'idempotencyKey',
      'postedAt',
      'description',
      'currency',
      'lines.0.direction',
    ])
  })

  it('rejects an entry id that is not a uuid before it reaches the database', async () => {
    const response = await get(acme, '/v1/entries/not-an-id')
    expect(response.statusCode).toBe(400)
    expect(json<ErrorResponse>(response).error.issues?.[0]?.path).toBe('entryId')
  })

  it('rejects a body that is not JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entries',
      headers: { 'x-tenant-id': acme, 'content-type': 'application/json' },
      payload: '{"idempotencyKey":',
    })

    expect(response.statusCode).toBe(400)
    expect(json<ErrorResponse>(response).error.code).toBe('malformed_request')
  })

  it('answers an unknown route in the same shape as every other refusal', async () => {
    const response = await get(acme, '/v1/nope')
    expect(response.statusCode).toBe(404)
    expect(json<ErrorResponse>(response).error.code).toBe('route_not_found')
  })
})

describe('error translation', () => {
  it("maps an unbalanced entry to 422 and keeps the database's own account of it", async () => {
    const response = await post(
      acme,
      entry('unbalanced', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '100.00' },
          { accountCode: '4000', direction: 'credit', amount: '99.99' },
        ],
      }),
    )

    expect(response.statusCode).toBe(422)
    const body = json<ErrorResponse>(response)
    expect(body.error.code).toBe('unbalanced_entry')
    expect(body.error.message).toContain('unbalanced')
    expect(body.error.detail).toContain('debits=')
  })

  it('maps an entry with no lines to 422, because the balance trigger sees it at commit', async () => {
    const response = await post(acme, entry('no-lines', { lines: [] }))

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('unbalanced_entry')
  })

  it('maps an unknown account to 422', async () => {
    const response = await post(
      acme,
      entry('unknown-account', {
        lines: [
          { accountCode: '9999', direction: 'debit', amount: '10.00' },
          { accountCode: '4000', direction: 'credit', amount: '10.00' },
        ],
      }),
    )

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('account_not_found')
  })

  it('maps a posting to an account with children to 422', async () => {
    const response = await post(
      acme,
      entry('rollup', {
        lines: [
          { accountCode: '1', direction: 'debit', amount: '10.00' },
          { accountCode: '4000', direction: 'credit', amount: '10.00' },
        ],
      }),
    )

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('rollup_account')
  })

  it('maps a zero amount to 422, because the CHECK constraint refuses it', async () => {
    const response = await post(
      acme,
      entry('zero', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '0.00' },
          { accountCode: '4000', direction: 'credit', amount: '0.00' },
        ],
      }),
    )

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('non_positive_amount')
  })

  it('maps a closed period to 422', async () => {
    const closed = await seedTenant(ledger, { slug: 'closed-books', periodsRequired: true })
    await ledger.createPeriod(closed.id, {
      name: '2026-03',
      from: '2026-03-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    })
    await ledger.setPeriodState(closed.id, '2026-03', 'closed')

    const response = await post(closed.id, entry('into-closed-period'))

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('closed_period')
  })

  it('maps an inactive account to 422', async () => {
    const dormant = await seedTenant(ledger, { slug: 'dormant' })
    await ledger.setAccountActive(dormant.id, '1000', false)

    const response = await post(dormant.id, entry('inactive'))

    expect(response.statusCode).toBe(422)
    expect(json<ErrorResponse>(response).error.code).toBe('inactive_account')
  })

  it('turns an error it does not recognise into a bare 500', async () => {
    // Built separately because a route cannot be added once an instance is
    // ready, and this one exists only to blow up.
    const failing = buildServer(db, { logger: false })
    failing.get('/boom', async () => {
      throw new Error('ECONNRESET while talking to 10.0.0.7:5432')
    })
    await failing.ready()

    const response = await failing.inject({ method: 'GET', url: '/boom' })
    await failing.close()

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('ECONNRESET')
    expect(response.body).not.toContain('at Object')
    const body = json<ErrorResponse>(response)
    expect(body.error.code).toBe('internal_error')
    expect(body.requestId).toHaveLength(36)
  })

  it('carries no stack trace on a refusal the database made', async () => {
    const response = await post(
      acme,
      entry('no-leak', {
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '5.00' },
          { accountCode: '4000', direction: 'credit', amount: '4.00' },
        ],
      }),
    )

    expect(response.statusCode).toBe(422)
    expect(response.body).not.toContain('at Object')
    expect(json<Record<string, unknown>>(response).stack).toBeUndefined()
  })

  it('echoes a request id on every response, including the failures', async () => {
    const supplied = 'e2c9b2f4-0d5a-4a2f-9a53-6b3c9f7d2a11'
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: { 'x-tenant-id': acme, 'x-request-id': supplied },
    })

    expect(response.headers['x-request-id']).toBe(supplied)

    const refused = await app.inject({
      method: 'GET',
      url: '/v1/entries/nope',
      headers: { 'x-tenant-id': acme, 'x-request-id': supplied },
    })
    expect(json<ErrorResponse>(refused).requestId).toBe(supplied)
  })
})

describe('reads', () => {
  it('returns the chart of accounts in code order', async () => {
    const response = await get(acme, '/v1/accounts')
    expect(response.statusCode).toBe(200)

    const { accounts } = json<{ accounts: { code: string }[] }>(response)
    expect(accounts).toHaveLength(CHART_OF_ACCOUNTS.length)
    expect(accounts.map((account) => account.code)).toEqual(
      [...accounts.map((account) => account.code)].sort(),
    )
  })

  it('returns a statement with a running balance', async () => {
    const response = await get(acme, '/v1/accounts/1000/statement?from=2026-01-01T00:00:00Z')
    expect(response.statusCode).toBe(200)

    const { rows } = json<{ rows: { runningBalance: string }[] }>(response)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.at(-1)?.runningBalance).toMatch(/^\d+\.\d{4}$/)
  })

  it('reports a statement for an account that does not exist as 404', async () => {
    const response = await get(acme, '/v1/accounts/9999/statement')
    expect(response.statusCode).toBe(404)
    expect(json<ErrorResponse>(response).error.code).toBe('account_not_found')
  })

  it('returns a trial balance whose debits equal its credits', async () => {
    const response = await get(acme, '/v1/reports/trial-balance')
    expect(response.statusCode).toBe(200)

    const { rows } = json<{ rows: { debits: string; credits: string }[] }>(response)
    const total = (side: 'debits' | 'credits'): number =>
      rows.reduce((sum, row) => sum + Number(row[side]), 0)
    expect(total('debits')).toBe(total('credits'))
  })
})

describe('pagination', () => {
  let pager: string

  beforeAll(async () => {
    pager = (await seedTenant(ledger, { slug: 'pager' })).id

    for (let i = 0; i < 5; i += 1) {
      await post(
        pager,
        entry(`page-${i}`, { postedAt: `2026-03-0${i + 1}T09:00:00Z` }),
      )
    }
  })

  it('walks every entry exactly once through the cursor', async () => {
    const seen: string[] = []
    let url = '/v1/entries?limit=2'
    let pages = 0

    for (;;) {
      const page = json<{ entries: EntryResponse[]; nextCursor: string | null }>(
        await get(pager, url),
      )
      pages += 1
      seen.push(...page.entries.map((e) => e.id))
      if (page.nextCursor === null) break
      url = `/v1/entries?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`
    }

    expect(pages).toBe(3)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('orders newest first', async () => {
    const { entries } = json<{ entries: EntryResponse[] }>(await get(pager, '/v1/entries'))
    const dates = entries.map((e) => e.postedAt)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it('refuses a limit outside the page size, and a cursor it did not issue', async () => {
    expect((await get(pager, '/v1/entries?limit=0')).statusCode).toBe(400)
    expect((await get(pager, '/v1/entries?limit=500')).statusCode).toBe(400)

    const response = await get(pager, '/v1/entries?cursor=bm90LWEtY3Vyc29y')
    expect(response.statusCode).toBe(400)
    expect(json<ErrorResponse>(response).error.issues?.[0]?.path).toBe('cursor')
  })
})
