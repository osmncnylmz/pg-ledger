/**
 * Invariant #1 -- every journal entry balances.
 *
 * Mechanism: sql/0006_balanced_entries.sql, a CONSTRAINT TRIGGER declared
 * DEFERRABLE INITIALLY DEFERRED on both journal tables.
 *
 * Each test writes raw SQL as the application role, bypassing the TypeScript
 * layer entirely. If any of these passed, the TypeScript layer's checks would
 * be the only thing standing between a bug and corrupt books.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { UnbalancedEntryError } from '../src/errors.js'
import { accountId, createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger)
})

afterAll(async () => {
  await fixture.close()
})

async function insertEntry(key: string, currency = 'EUR'): Promise<string> {
  return fixture.db.asTenant(tenant.id, async (session) => {
    const row = await session.one<{ id: string }>(
      `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
       values ($1, $2, now(), 'raw sql', $3::ledger.currency_code)
       returning id`,
      [tenant.id, key, currency],
    )
    return row.id
  })
}

describe('invariant 1: balanced entries', () => {
  it('accepts lines inserted one statement at a time inside a transaction', async () => {
    // This is the whole point of deferring. Between the two INSERTs the entry
    // is unbalanced, and the database is fine with that -- until COMMIT.
    const cash = await accountId(fixture.db, tenant.id, '1000')
    const sales = await accountId(fixture.db, tenant.id, '4000')

    const entryId = await fixture.db.asTenant(tenant.id, async (session) => {
      const entry = await session.one<{ id: string }>(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'one-at-a-time', now(), 'line by line', 'EUR')
         returning id`,
        [tenant.id],
      )

      await session.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 1, $3, 'debit', 100.0000, 'EUR')`,
        [tenant.id, entry.id, cash],
      )

      // Mid-transaction the books do not balance, and reading them back
      // confirms it. No error so far.
      const midway = await session.one<{ debits: string; credits: string }>(
        `select coalesce(sum(amount) filter (where direction = 'debit'), 0)::text as debits,
                coalesce(sum(amount) filter (where direction = 'credit'), 0)::text as credits
           from ledger.journal_lines where entry_id = $1`,
        [entry.id],
      )
      expect(midway.debits).toBe('100.0000')
      expect(midway.credits).toBe('0')

      await session.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 2, $3, 'credit', 100.0000, 'EUR')`,
        [tenant.id, entry.id, sales],
      )

      return entry.id
    })

    expect(entryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses an entry whose debits and credits differ, at COMMIT', async () => {
    const cash = await accountId(fixture.db, tenant.id, '1000')
    const sales = await accountId(fixture.db, tenant.id, '4000')

    const attack = fixture.db.asTenant(tenant.id, async (session) => {
      const entry = await session.one<{ id: string }>(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'off-by-a-cent', now(), 'skimming', 'EUR')
         returning id`,
        [tenant.id],
      )
      await session.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 1, $3, 'debit', 100.0000, 'EUR'),
                ($1, $2, 2, $4, 'credit', 99.9900, 'EUR')`,
        [tenant.id, entry.id, cash, sales],
      )
    })

    await expect(attack).rejects.toBeInstanceOf(UnbalancedEntryError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG001' })
    await expect(attack).rejects.toThrow(/difference 0\.0100/)
  })

  it('refuses an entry with no lines at all', async () => {
    const attack = insertEntry('empty-entry')
    await expect(attack).rejects.toBeInstanceOf(UnbalancedEntryError)
    await expect(attack).rejects.toThrow(/has no lines/)
  })

  it('refuses a line appended to an already balanced entry in a later transaction', async () => {
    // The trigger on journal_entries alone would miss this: the entry row was
    // inserted, checked and committed in an earlier transaction. The second
    // constraint trigger, on journal_lines, is what catches it.
    const posted = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'balanced-then-tampered',
      postedAt: new Date('2026-04-01T09:00:00Z'),
      description: 'Sale',
      currency: 'EUR',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '50.0000' },
        { accountCode: '4000', direction: 'credit', amount: '50.0000' },
      ],
    })

    const cash = await accountId(fixture.db, tenant.id, '1000')

    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 99, $3, 'debit', 1000.0000, 'EUR')`,
        [tenant.id, posted.entryId, cash],
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(UnbalancedEntryError)
  })

  it('accepts a multi-line entry that balances in aggregate', async () => {
    const result = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'split-invoice',
      postedAt: new Date('2026-04-02T09:00:00Z'),
      description: 'Invoice with VAT',
      currency: 'EUR',
      lines: [
        { accountCode: '1100', direction: 'debit', amount: '121.0000' },
        { accountCode: '4000', direction: 'credit', amount: '100.0000' },
        { accountCode: '2100', direction: 'credit', amount: '21.0000' },
      ],
    })

    const entry = await fixture.ledger.getEntry(tenant.id, result.entryId)
    expect(entry?.lines).toHaveLength(3)
    expect(entry?.lines.map((l) => l.lineNo)).toEqual([1, 2, 3])
  })

  it('rejects the whole transaction, leaving no partial entry behind', async () => {
    const before = await fixture.ledger.trialBalance(tenant.id)

    await expect(
      fixture.ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: 'rolled-back',
        postedAt: new Date('2026-04-03T09:00:00Z'),
        description: 'Broken',
        currency: 'EUR',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '10.0000' },
          { accountCode: '4000', direction: 'credit', amount: '9.0000' },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError)

    const after = await fixture.ledger.trialBalance(tenant.id)
    expect(after).toEqual(before)

    const orphan = await fixture.db.asTenant(tenant.id, (session) =>
      session.query('select id from ledger.journal_entries where idempotency_key = $1', [
        'rolled-back',
      ]),
    )
    expect(orphan).toHaveLength(0)
  })
})
