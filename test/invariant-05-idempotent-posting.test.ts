/**
 * Invariant #5 -- posting is idempotent.
 *
 * It comes down to the unique constraint on (tenant_id, idempotency_key) in
 * sql/0005_journal.sql, driving an INSERT ... ON CONFLICT DO NOTHING inside
 * ledger.post_entry (sql/0011_posting_api.sql).
 *
 * A note on "concurrent". PGlite is a single embedded backend, so the
 * overlapping calls below are serialised by the driver rather than executed
 * by separate processes: what they demonstrate is that overlapping *callers*
 * converge on one entry, not that two PostgreSQL backends race. The
 * cross-connection guarantee comes from the unique index itself -- a second
 * inserter blocks on the index tuple until the first commits, then finds the
 * winning row -- and that behaviour is a property of PostgreSQL, not of this
 * schema. The test that a duplicate raises 23505 pins the index down.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DuplicateIdempotencyKeyError } from '../src/errors.js'
import { createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant
let other: SeededTenant

const PAYMENT = {
  postedAt: new Date('2026-07-01T09:00:00Z'),
  description: 'Card capture',
  currency: 'EUR',
  lines: [
    { accountCode: '1000', direction: 'debit' as const, amount: '42.5000' },
    { accountCode: '4000', direction: 'credit' as const, amount: '42.5000' },
  ],
}

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'retry-ltd' })
  other = await seedTenant(fixture.ledger, { slug: 'other-ltd' })
})

afterAll(async () => {
  await fixture.db.close()
})

async function entryCount(tenantId: string, key: string): Promise<number> {
  const rows = await fixture.db.asTenant(tenantId, (session) =>
    session.query('select id from ledger.journal_entries where idempotency_key = $1', [key]),
  )
  return rows.length
}

describe('invariant 5: idempotent posting', () => {
  it('returns the original entry on a replay and writes nothing', async () => {
    const first = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'charge-abc',
      ...PAYMENT,
    })
    const second = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'charge-abc',
      ...PAYMENT,
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.entryId).toBe(first.entryId)
    expect(await entryCount(tenant.id, 'charge-abc')).toBe(1)

    const entry = await fixture.ledger.getEntry(tenant.id, first.entryId)
    expect(entry?.lines).toHaveLength(2)
  })

  it('ignores the payload of a replay entirely', async () => {
    // A retried request whose body drifted must not append lines to, or
    // otherwise mutate, the entry that already exists.
    const replay = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'charge-abc',
      postedAt: new Date('2027-01-01T00:00:00Z'),
      description: 'Completely different',
      currency: 'USD',
      lines: [
        { accountCode: '1200', direction: 'debit', amount: '999999.0000' },
        { accountCode: '4100', direction: 'credit', amount: '999999.0000' },
      ],
    })

    expect(replay.created).toBe(false)

    const entry = await fixture.ledger.getEntry(tenant.id, replay.entryId)
    expect(entry?.description).toBe('Card capture')
    expect(entry?.currency).toBe('EUR')
    expect(entry?.lines).toHaveLength(2)
    expect(entry?.lines.map((l) => l.amount)).toEqual(['42.5000', '42.5000'])
  })

  it('converges on a single entry when 25 overlapping calls use one key', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        fixture.ledger.postEntry({
          tenantId: tenant.id,
          idempotencyKey: 'charge-storm',
          ...PAYMENT,
        }),
      ),
    )

    const ids = new Set(results.map((r) => r.entryId))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await entryCount(tenant.id, 'charge-storm')).toBe(1)

    const [cash] = await fixture.ledger.currentBalances(tenant.id)
    expect(cash?.code).toBe('1000')
    expect(cash?.debitTotal).toBe('85.0000') // charge-abc + charge-storm
  })

  it('rests on a unique index, not on a read-then-write check', async () => {
    const first = await fixture.db.asTenant(tenant.id, (session) =>
      session.query('select id from ledger.journal_entries where idempotency_key = $1', [
        'charge-abc',
      ]),
    )
    expect(first).toHaveLength(1)

    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'charge-abc', now(), 'duplicate', 'EUR')`,
        [tenant.id],
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError)
    await expect(attack).rejects.toMatchObject({
      sqlState: '23505',
      constraint: 'journal_entries_idempotency_key_key',
    })
  })

  it('scopes idempotency keys to the tenant', async () => {
    const mine = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'shared-key',
      ...PAYMENT,
    })
    const theirs = await fixture.ledger.postEntry({
      tenantId: other.id,
      idempotencyKey: 'shared-key',
      ...PAYMENT,
    })

    expect(mine.created).toBe(true)
    expect(theirs.created).toBe(true)
    expect(mine.entryId).not.toBe(theirs.entryId)
  })

  it('gives reversals a deterministic key so a retried reversal is also idempotent', async () => {
    const posted = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'to-reverse',
      ...PAYMENT,
    })
    const reversalId = await fixture.ledger.reverseEntry({
      tenantId: tenant.id,
      entryId: posted.entryId,
    })

    const reversal = await fixture.ledger.getEntry(tenant.id, reversalId)
    expect(reversal?.idempotencyKey).toBe(`reversal:${posted.entryId}`)

    // A retry hits either the reversal guard or the idempotency key; both
    // leave exactly one reversal behind.
    await expect(
      fixture.ledger.reverseEntry({ tenantId: tenant.id, entryId: posted.entryId }),
    ).rejects.toMatchObject({ sqlState: expect.stringMatching(/LG009|23505/) as unknown as string })

    expect(await entryCount(tenant.id, `reversal:${posted.entryId}`)).toBe(1)
  })
})
