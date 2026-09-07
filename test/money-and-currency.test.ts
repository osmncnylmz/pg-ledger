/**
 * Money is numeric, amounts are magnitudes, and an entry has one currency.
 *
 * Mechanisms: the numeric(20,4) columns and the `journal_lines_amount_positive`
 * check in sql/0005_journal.sql, the `journal_lines_currency_matches_entry`
 * composite foreign key in the same file, and the `ledger.currency_code`
 * domain in sql/0001_foundation.sql.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MixedCurrencyError, NonPositiveAmountError } from '../src/errors.js'
import { accountId, createFixture, seedTenant, sumMoney, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'money-ltd' })
})

afterAll(async () => {
  await fixture.close()
})

async function rawLine(
  entryKey: string,
  currency: string,
  lineCurrency: string,
  amount: string,
): Promise<void> {
  const cash = await accountId(fixture.db, tenant.id, '1000')
  await fixture.db.asTenant(tenant.id, async (session) => {
    const entry = await session.one<{ id: string }>(
      `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
       values ($1, $2, now(), 'raw', $3::ledger.currency_code)
       returning id`,
      [tenant.id, entryKey, currency],
    )
    await session.query(
      `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
       values ($1, $2, 1, $3, 'debit', $4::numeric, $5::ledger.currency_code)`,
      [tenant.id, entry.id, cash, amount, lineCurrency],
    )
  })
}

describe('amounts', () => {
  it('refuses a negative amount', async () => {
    const attack = rawLine('negative', 'EUR', 'EUR', '-100.0000')
    await expect(attack).rejects.toBeInstanceOf(NonPositiveAmountError)
    await expect(attack).rejects.toMatchObject({ constraint: 'journal_lines_amount_positive' })
  })

  it('refuses a zero amount', async () => {
    await expect(rawLine('zero', 'EUR', 'EUR', '0')).rejects.toBeInstanceOf(NonPositiveAmountError)
  })

  it('refuses a negative amount through the posting API as well', async () => {
    await expect(
      fixture.ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: 'negative-api',
        postedAt: new Date('2026-08-01T00:00:00Z'),
        description: 'Refund done wrong',
        currency: 'EUR',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '-50.0000' },
          { accountCode: '4000', direction: 'credit', amount: '-50.0000' },
        ],
      }),
    ).rejects.toBeInstanceOf(NonPositiveAmountError)
  })

  it('stores money exactly, with no binary floating point in the path', async () => {
    // 0.1 + 0.2 is the canonical float trap. Here the sum is a decimal sum.
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'exact-decimals',
      postedAt: new Date('2026-08-02T00:00:00Z'),
      description: 'Thirds',
      currency: 'EUR',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '0.1000' },
        { accountCode: '1100', direction: 'debit', amount: '0.2000' },
        { accountCode: '4000', direction: 'credit', amount: '0.3000' },
      ],
    })

    const balances = await fixture.ledger.trialBalance(tenant.id)
    const debits = balances.map((r) => r.debits)
    const credits = balances.map((r) => r.credits)
    expect(sumMoney(debits)).toBe(sumMoney(credits))
    expect(balances.find((r) => r.code === '4000')?.credits).toBe('0.3000')
  })

  it('keeps four decimal places and rejects a fifth', async () => {
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'fractions-of-a-cent',
      postedAt: new Date('2026-08-03T00:00:00Z'),
      description: 'Interest accrual',
      currency: 'EUR',
      lines: [
        { accountCode: '1100', direction: 'debit', amount: '0.0001' },
        { accountCode: '4100', direction: 'credit', amount: '0.0001' },
      ],
    })

    const statement = await fixture.ledger.statement(tenant.id, '1100')
    expect(statement.some((row) => row.debit === '0.0001')).toBe(true)

    // numeric(20,4) rounds a fifth decimal rather than storing it, which is a
    // silent change of value. Rounding at the boundary is a deliberate schema
    // decision, so pin it down rather than leave it to chance.
    const rounded = await fixture.db.asTenant(tenant.id, (session) =>
      session.one<{ amount: string }>("select 0.00005::numeric(20,4) as amount"),
    )
    expect(rounded.amount).toBe('0.0001')
  })

  it('refuses an amount that overflows numeric(20,4)', async () => {
    await expect(rawLine('too-big', 'EUR', 'EUR', '1e17')).rejects.toMatchObject({
      code: '22003',
    })
  })
})

describe('currency', () => {
  it('makes a mixed-currency entry unrepresentable', async () => {
    const attack = rawLine('mixed', 'EUR', 'USD', '10.0000')
    await expect(attack).rejects.toBeInstanceOf(MixedCurrencyError)
    await expect(attack).rejects.toMatchObject({
      constraint: 'journal_lines_currency_matches_entry',
    })
  })

  it('refuses a currency code that is not ISO 4217 shaped', async () => {
    for (const bad of ['eur', 'EURO', 'E1']) {
      await expect(
        fixture.db.asTenant(tenant.id, (session) =>
          session.query(
            `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
             values ($1, $2, now(), 'bad currency', $3::ledger.currency_code)`,
            [tenant.id, `bad-${bad}`, bad],
          ),
        ),
      ).rejects.toMatchObject({ constraint: 'currency_code_iso4217' })
    }
  })

  it('keeps balances per currency for the same account', async () => {
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'usd-sale',
      postedAt: new Date('2026-08-04T00:00:00Z'),
      description: 'Sale in dollars',
      currency: 'USD',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '500.0000' },
        { accountCode: '4000', direction: 'credit', amount: '500.0000' },
      ],
    })

    const cash = (await fixture.ledger.currentBalances(tenant.id)).filter((r) => r.code === '1000')
    const byCurrency = Object.fromEntries(cash.map((r) => [r.currency, r.balance]))

    expect(byCurrency.USD).toBe('500.0000')
    expect(byCurrency.EUR).toBeDefined()
    expect(byCurrency.EUR).not.toBe(byCurrency.USD)

    // And the trial balance nets to zero within each currency, separately.
    const trial = await fixture.ledger.trialBalance(tenant.id)
    for (const currency of ['EUR', 'USD']) {
      const rows = trial.filter((r) => r.currency === currency)
      expect(sumMoney(rows.map((r) => r.debits))).toBe(sumMoney(rows.map((r) => r.credits)))
    }
  })
})
