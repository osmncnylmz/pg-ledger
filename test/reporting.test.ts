/**
 * The reporting layer, checked against a small set of books with known
 * numbers.
 *
 * Mechanisms: sql/0012_reporting.sql -- the trial balance, the running
 * balance built with a window function, and the chart-of-accounts rollups
 * built with two recursive CTEs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createFixture, seedTenant, sumMoney, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant

const JANUARY_END = '2026-01-31T23:59:59Z'
const QUARTER_END = '2026-03-31T23:59:59Z'

/** A quarter of trading, chosen so every number below is checkable by hand. */
const BOOKS = [
  {
    key: 'share-capital',
    at: '2026-01-05T09:00:00Z',
    description: 'Founders subscribe for shares',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '50000.0000' },
      { accountCode: '3000', direction: 'credit', amount: '50000.0000' },
    ],
  },
  {
    key: 'january-rent',
    at: '2026-01-10T09:00:00Z',
    description: 'January rent',
    lines: [
      { accountCode: '5200', direction: 'debit', amount: '2000.0000' },
      { accountCode: '1000', direction: 'credit', amount: '2000.0000' },
    ],
  },
  {
    key: 'stock-purchase',
    at: '2026-01-15T09:00:00Z',
    description: 'Stock bought on account',
    lines: [
      { accountCode: '1200', direction: 'debit', amount: '8000.0000' },
      { accountCode: '2000', direction: 'credit', amount: '8000.0000' },
    ],
  },
  {
    key: 'invoice-001',
    at: '2026-01-20T09:00:00Z',
    description: 'Invoice 001 with VAT',
    lines: [
      { accountCode: '1100', direction: 'debit', amount: '12100.0000' },
      { accountCode: '4000', direction: 'credit', amount: '10000.0000' },
      { accountCode: '2100', direction: 'credit', amount: '2100.0000' },
    ],
  },
  {
    key: 'invoice-001-paid',
    at: '2026-02-05T09:00:00Z',
    description: 'Invoice 001 settled',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '12100.0000' },
      { accountCode: '1100', direction: 'credit', amount: '12100.0000' },
    ],
  },
  {
    key: 'february-salaries',
    at: '2026-02-15T09:00:00Z',
    description: 'February salaries',
    lines: [
      { accountCode: '5100', direction: 'debit', amount: '6000.0000' },
      { accountCode: '1000', direction: 'credit', amount: '6000.0000' },
    ],
  },
  {
    key: 'consulting-fee',
    at: '2026-02-20T09:00:00Z',
    description: 'Consulting fee received',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '3000.0000' },
      { accountCode: '4100', direction: 'credit', amount: '3000.0000' },
    ],
  },
  {
    key: 'cost-of-goods',
    at: '2026-03-01T09:00:00Z',
    description: 'Cost of goods sold',
    lines: [
      { accountCode: '5000', direction: 'debit', amount: '4000.0000' },
      { accountCode: '1200', direction: 'credit', amount: '4000.0000' },
    ],
  },
] as const

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'reports-ltd' })

  for (const entry of BOOKS) {
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: entry.key,
      postedAt: entry.at,
      description: entry.description,
      currency: 'EUR',
      lines: entry.lines.map((l) => ({ ...l })),
    })
  }
})

afterAll(async () => {
  await fixture.close()
})

describe('trial balance', () => {
  it('nets to zero', async () => {
    const rows = await fixture.ledger.trialBalance(tenant.id, QUARTER_END)
    expect(sumMoney(rows.map((r) => r.debits))).toBe('97200.0000')
    expect(sumMoney(rows.map((r) => r.credits))).toBe('97200.0000')
    expect(sumMoney(rows.map((r) => r.balance))).toBe('0.0000')
  })

  it('reports each account on its own normal side', async () => {
    const rows = await fixture.ledger.trialBalance(tenant.id, QUARTER_END)
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]))

    expect(byCode['1000']?.debits).toBe('65100.0000')
    expect(byCode['1000']?.credits).toBe('8000.0000')
    expect(byCode['1000']?.balance).toBe('57100.0000')
    expect(byCode['1000']?.normalAmount).toBe('57100.0000')

    // A credit-normal account: the raw balance is negative, the normal
    // amount is positive.
    expect(byCode['2000']?.balance).toBe('-8000.0000')
    expect(byCode['2000']?.normalAmount).toBe('8000.0000')

    // Receivables were raised and settled: still on the report, at zero.
    expect(byCode['1100']?.debits).toBe('12100.0000')
    expect(byCode['1100']?.credits).toBe('12100.0000')
    expect(byCode['1100']?.balance).toBe('0.0000')
  })

  it('honours the as-of date', async () => {
    const january = await fixture.ledger.trialBalance(tenant.id, JANUARY_END)
    const byCode = Object.fromEntries(january.map((r) => [r.code, r]))

    expect(byCode['1000']?.balance).toBe('48000.0000')
    expect(byCode['5100']).toBeUndefined() // February salaries, not yet posted
    expect(sumMoney(january.map((r) => r.debits))).toBe('72100.0000')
    expect(sumMoney(january.map((r) => r.debits))).toBe(
      sumMoney(january.map((r) => r.credits)),
    )
  })

  it('nets to zero at every instant, not only at the end', async () => {
    for (const at of BOOKS.map((b) => b.at)) {
      const rows = await fixture.ledger.trialBalance(tenant.id, at)
      expect(sumMoney(rows.map((r) => r.balance))).toBe('0.0000')
    }
  })
})

describe('account statement', () => {
  it('carries a running balance in the account normal direction', async () => {
    const rows = await fixture.ledger.statement(tenant.id, '1000')

    expect(rows.map((r) => [r.debit, r.credit, r.runningBalance])).toEqual([
      ['50000.0000', '0.0000', '50000.0000'],
      ['0.0000', '2000.0000', '48000.0000'],
      ['12100.0000', '0.0000', '60100.0000'],
      ['0.0000', '6000.0000', '54100.0000'],
      ['3000.0000', '0.0000', '57100.0000'],
    ])
  })

  it('opens a date-filtered statement with the balance brought forward', async () => {
    // The window frame runs from the beginning of time and the date filter is
    // applied afterwards, so February opens at January's closing balance
    // rather than at zero.
    const february = await fixture.ledger.statement(tenant.id, '1000', {
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-28T23:59:59Z',
    })

    expect(february).toHaveLength(3)
    expect(february[0]?.runningBalance).toBe('60100.0000')
    expect(february.at(-1)?.runningBalance).toBe('57100.0000')
  })

  it('flips the sign for a credit-normal account', async () => {
    const rows = await fixture.ledger.statement(tenant.id, '2000')
    // A credit on a liability increases it.
    expect(rows.map((r) => [r.direction, r.signedAmount, r.runningBalance])).toEqual([
      ['credit', '8000.0000', '8000.0000'],
    ])
  })

  it('shows a receivable rising and falling back to zero', async () => {
    const rows = await fixture.ledger.statement(tenant.id, '1100')
    expect(rows.map((r) => r.runningBalance)).toEqual(['12100.0000', '0.0000'])
  })
})

describe('rollups over the account tree', () => {
  it('sums a subtree with a recursive CTE', async () => {
    const rows = await fixture.ledger.balanceSheet(tenant.id, QUARTER_END)
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]))

    expect(byCode['1']?.depth).toBe(0)
    expect(byCode['1']?.isLeaf).toBe(false)
    expect(byCode['1']?.ownAmount).toBe('0.0000') // parents hold nothing themselves
    expect(byCode['1']?.subtreeAmount).toBe('61100.0000') // 57100 cash + 0 AR + 4000 stock

    expect(byCode['1000']?.depth).toBe(1)
    expect(byCode['1000']?.isLeaf).toBe(true)
    expect(byCode['1000']?.path).toEqual(['1', '1000'])
    expect(byCode['1000']?.ownAmount).toBe('57100.0000')
    expect(byCode['1000']?.subtreeAmount).toBe('57100.0000')

    expect(byCode['2']?.subtreeAmount).toBe('10100.0000')
    expect(byCode['3']?.subtreeAmount).toBe('50000.0000')
  })

  it('produces an income statement for a chosen window', async () => {
    const quarter = await fixture.ledger.incomeStatement(
      tenant.id,
      '2026-01-01T00:00:00Z',
      QUARTER_END,
    )
    const byCode = Object.fromEntries(quarter.map((r) => [r.code, r]))
    expect(byCode['4']?.subtreeAmount).toBe('13000.0000')
    expect(byCode['5']?.subtreeAmount).toBe('12000.0000')

    const february = await fixture.ledger.incomeStatement(
      tenant.id,
      '2026-02-01T00:00:00Z',
      '2026-02-28T23:59:59Z',
    )
    const feb = Object.fromEntries(february.map((r) => [r.code, r]))
    expect(feb['4']?.subtreeAmount).toBe('3000.0000')
    expect(feb['5']?.subtreeAmount).toBe('6000.0000')
    expect(feb['5000']).toBeUndefined() // March cost of goods
  })

  it('orders rows so the report can be printed with indentation', async () => {
    const rows = await fixture.ledger.balanceSheet(tenant.id, QUARTER_END)
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.code}`)).toEqual([
      '1',
      '  1000',
      '  1100',
      '  1200',
      '2',
      '  2000',
      '  2100',
      '3',
      '  3000',
    ])
  })
})

describe('the accounting equation', () => {
  it('holds exactly', async () => {
    const [row] = await fixture.ledger.accountingEquation(tenant.id, QUARTER_END)

    expect(row?.currency).toBe('EUR')
    expect(row?.assets).toBe('61100.0000')
    expect(row?.liabilities).toBe('10100.0000')
    expect(row?.equity).toBe('50000.0000')
    expect(row?.revenue).toBe('13000.0000')
    expect(row?.expenses).toBe('12000.0000')
    expect(row?.netIncome).toBe('1000.0000')
    expect(row?.difference).toBe('0.0000')
  })

  it('still holds after a reversal', async () => {
    const rows = await fixture.ledger.trialBalance(tenant.id, QUARTER_END)
    const salariesEntry = await fixture.db.asTenant(tenant.id, (session) =>
      session.one<{ id: string }>(
        'select id from ledger.journal_entries where idempotency_key = $1',
        ['february-salaries'],
      ),
    )
    expect(rows.length).toBeGreaterThan(0)

    await fixture.ledger.reverseEntry({
      tenantId: tenant.id,
      entryId: salariesEntry.id,
      postedAt: '2026-03-15T09:00:00Z',
    })

    const [row] = await fixture.ledger.accountingEquation(tenant.id, QUARTER_END)
    expect(row?.difference).toBe('0.0000')
    expect(row?.expenses).toBe('6000.0000') // salaries backed out
    expect(row?.assets).toBe('67100.0000') // cash returned
  })
})
