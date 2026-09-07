/**
 * The incrementally maintained balance cache, and the reconciliation that
 * makes it trustworthy.
 *
 * Mechanism: sql/0010_account_balances.sql (the table, the statement-level
 * trigger with a transition table, the SECURITY DEFINER write path) and
 * ledger.reconcile_balances in sql/0012_reporting.sql.
 *
 * A cache is only worth having if you can prove it agrees with the source of
 * truth. The reconciliation test cuts both ways here: it shows the cache
 * matches a full recomputation, *and* -- by deliberately corrupting a row --
 * that the comparison would notice if it did not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { InsufficientPrivilegeError, UnbalancedEntryError } from '../src/errors.js'
import { createFixture, seedTenant, sumMoney, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'cache-ltd' })

  await fixture.ledger.postEntry({
    tenantId: tenant.id,
    idempotencyKey: 'opening',
    postedAt: '2026-01-01T09:00:00Z',
    description: 'Opening balance',
    currency: 'EUR',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '10000.0000' },
      { accountCode: '3000', direction: 'credit', amount: '10000.0000' },
    ],
  })
})

afterAll(async () => {
  await fixture.close()
})

describe('the balance cache', () => {
  it('is updated in the same transaction as the posting', async () => {
    const before = await fixture.ledger.currentBalances(tenant.id)
    expect(before.find((r) => r.code === '1000')?.balance).toBe('10000.0000')

    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'rent',
      postedAt: '2026-01-02T09:00:00Z',
      description: 'Rent',
      currency: 'EUR',
      lines: [
        { accountCode: '5200', direction: 'debit', amount: '1500.0000' },
        { accountCode: '1000', direction: 'credit', amount: '1500.0000' },
      ],
    })

    const after = await fixture.ledger.currentBalances(tenant.id)
    expect(after.find((r) => r.code === '1000')?.balance).toBe('8500.0000')
    expect(after.find((r) => r.code === '1000')?.lineCount).toBe(2)
  })

  it('rolls back with a posting the database refuses', async () => {
    const before = await fixture.ledger.currentBalances(tenant.id)

    await expect(
      fixture.ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: 'unbalanced',
        postedAt: '2026-01-03T09:00:00Z',
        description: 'Broken',
        currency: 'EUR',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '10.0000' },
          { accountCode: '4000', direction: 'credit', amount: '9.0000' },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError)

    // The cache write happened before the deferred balance check fired, so
    // this only holds because both live in one transaction.
    expect(await fixture.ledger.currentBalances(tenant.id)).toEqual(before)
  })

  it('groups a many-line entry into one row per account and currency', async () => {
    // The trigger is FOR EACH STATEMENT with a transition table, so a 20-line
    // entry is one grouped UPSERT rather than 20 round trips.
    const lines = Array.from({ length: 10 }, (_, i) => ({
      accountCode: '5100',
      direction: 'debit' as const,
      amount: '100.0000',
      memo: `employee ${i + 1}`,
    }))

    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'payroll',
      postedAt: '2026-01-04T09:00:00Z',
      description: 'Payroll run',
      currency: 'EUR',
      lines: [...lines, { accountCode: '1000', direction: 'credit', amount: '1000.0000' }],
    })

    const salaries = (await fixture.ledger.currentBalances(tenant.id)).find(
      (r) => r.code === '5100',
    )
    expect(salaries?.debitTotal).toBe('1000.0000')
    expect(salaries?.lineCount).toBe(10)
  })

  it('keeps one row per currency for the same account', async () => {
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'usd-consulting',
      postedAt: '2026-01-05T09:00:00Z',
      description: 'Consulting in USD',
      currency: 'USD',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '2500.0000' },
        { accountCode: '4100', direction: 'credit', amount: '2500.0000' },
      ],
    })

    const cash = (await fixture.ledger.currentBalances(tenant.id)).filter((r) => r.code === '1000')
    expect(cash.map((r) => [r.currency, r.balance])).toEqual([
      ['EUR', '7500.0000'],
      ['USD', '2500.0000'],
    ])
  })

  it('cannot be written by the application role', async () => {
    // ledger_app holds SELECT only. The trigger writes through a SECURITY
    // DEFINER function owned by ledger_owner.
    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query('update ledger.account_balances set debit_total = 0'),
      ),
    ).rejects.toBeInstanceOf(InsufficientPrivilegeError)

    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query('delete from ledger.account_balances'),
      ),
    ).rejects.toBeInstanceOf(InsufficientPrivilegeError)
  })
})

describe('reconciliation', () => {
  it('agrees with a full recomputation from the journal', async () => {
    expect(await fixture.ledger.reconcileBalances(tenant.id)).toEqual([])
  })

  it('agrees line for line with the trial balance', async () => {
    const cached = await fixture.ledger.currentBalances(tenant.id)
    const trial = await fixture.ledger.trialBalance(tenant.id, '2100-01-01T00:00:00Z')

    expect(cached.map((r) => [r.code, r.currency, r.debitTotal, r.creditTotal])).toEqual(
      trial.map((r) => [r.code, r.currency, r.debits, r.credits]),
    )
    expect(sumMoney(cached.map((r) => r.balance))).toBe('0.0000')
  })

  it('detects drift when the cache is corrupted behind the trigger', async () => {
    // Without this the "reconciliation is empty" assertion above would be
    // vacuous: an implementation that always returned no rows would pass.
    await fixture.db.asTenant(
      tenant.id,
      (session) =>
        session.query(
          `update ledger.account_balances
              set debit_total = debit_total + 0.0100
            where account_id = (select id from ledger.accounts
                                 where tenant_id = $1 and code = '1000')
              and currency = 'EUR'`,
          [tenant.id],
        ),
      { role: 'ledger_owner' },
    )

    const drift = await fixture.ledger.reconcileBalances(tenant.id)
    expect(drift).toHaveLength(1)
    expect(drift[0]?.code).toBe('1000')
    expect(drift[0]?.cachedDebit).toBe('10000.0100')
    expect(drift[0]?.actualDebit).toBe('10000.0000')
  })

  it('repairs the cache by rebuilding it from the journal', async () => {
    const written = await fixture.ledger.rebuildBalances(tenant.id)
    expect(written).toBeGreaterThan(0)
    expect(await fixture.ledger.reconcileBalances(tenant.id)).toEqual([])

    const cash = (await fixture.ledger.currentBalances(tenant.id)).find(
      (r) => r.code === '1000' && r.currency === 'EUR',
    )
    expect(cash?.debitTotal).toBe('10000.0000')
  })

  it('notices a row that the cache is missing entirely', async () => {
    await fixture.db.asTenant(
      tenant.id,
      (session) =>
        session.query(
          `delete from ledger.account_balances
            where account_id = (select id from ledger.accounts
                                 where tenant_id = $1 and code = '5200')`,
          [tenant.id],
        ),
      { role: 'ledger_owner' },
    )

    const drift = await fixture.ledger.reconcileBalances(tenant.id)
    expect(drift).toHaveLength(1)
    expect(drift[0]?.code).toBe('5200')
    expect(drift[0]?.cachedDebit).toBeNull()
    expect(drift[0]?.actualDebit).toBe('1500.0000')

    await fixture.ledger.rebuildBalances(tenant.id)
    expect(await fixture.ledger.reconcileBalances(tenant.id)).toEqual([])
  })
})
