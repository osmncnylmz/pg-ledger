/**
 * Property test. The generator below builds 300 entries out of one to three
 * debit lines and one or two credits over the 11 leaf codes in
 * CHART_OF_ACCOUNTS, in EUR/USD/GBP, dated somewhere in 2026, at amounts
 * between 0.01 and 9999.99; the last credit line absorbs the remainder, so
 * every entry balances by construction and only the shape varies. Then about
 * one entry in ten gets reversed.
 *
 * Randomness comes from seededRandom(SEED), a plain LCG -- no fast-check, no
 * shrinking. The seed is in the describe() name, so a red build tells you
 * which books to rebuild: put that number in SEED and the same 300 entries
 * come back. Change ENTRY_COUNT or the CURRENCIES list and the whole sequence
 * moves, which is worth knowing before you widen the generator to chase a
 * failure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createFixture,
  LEAF_CODES,
  seedTenant,
  seededRandom,
  sumMoney,
  type Fixture,
  type SeededTenant,
} from './helpers.js'

const SEED = 20260101
const ENTRY_COUNT = 300
const CURRENCIES = ['EUR', 'USD', 'GBP']

let fixture: Fixture
let tenant: SeededTenant
const postedIds: string[] = []
let reversedCount = 0

const random = seededRandom(SEED)

function pick<T>(values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

/** A random amount in [0.01, 9999.99], as an exact 4dp decimal string. */
function amount(): string {
  const cents = 1 + Math.floor(random() * 999_999)
  return `${Math.floor(cents / 100)}.${(cents % 100).toString().padStart(2, '0')}00`
}

/**
 * Build a balanced entry: one to four debit lines, and credit lines that add
 * up to the same total. The last credit line absorbs the remainder, so the
 * generator produces genuinely varied shapes without ever failing to balance.
 */
function randomEntry(index: number): {
  idempotencyKey: string
  postedAt: string
  description: string
  currency: string
  lines: { accountCode: string; direction: 'debit' | 'credit'; amount: string }[]
} {
  const debitCount = 1 + Math.floor(random() * 3)
  const debits = Array.from({ length: debitCount }, () => ({
    accountCode: pick(LEAF_CODES),
    direction: 'debit' as const,
    amount: amount(),
  }))

  const total = sumMoney(debits.map((l) => l.amount))
  const creditCount = 1 + Math.floor(random() * 2)

  const credits: { accountCode: string; direction: 'credit'; amount: string }[] = []
  let remaining = total
  for (let i = 0; i < creditCount - 1; i += 1) {
    const half = splitHalf(remaining)
    if (half === '0.0000') break
    credits.push({ accountCode: pick(LEAF_CODES), direction: 'credit', amount: half })
    remaining = subtract(remaining, half)
  }
  credits.push({ accountCode: pick(LEAF_CODES), direction: 'credit', amount: remaining })

  const day = 1 + Math.floor(random() * 27)
  const month = 1 + Math.floor(random() * 12)

  return {
    idempotencyKey: `random-${index}`,
    postedAt: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00Z`,
    description: `Generated entry ${index}`,
    currency: pick(CURRENCIES),
    lines: [...debits, ...credits],
  }
}

function splitHalf(value: string): string {
  const cents = BigInt(value.replace('.', ''))
  const half = (cents / 20000n) * 10000n // round down to whole units
  return format(half)
}

function subtract(a: string, b: string): string {
  return format(BigInt(a.replace('.', '')) - BigInt(b.replace('.', '')))
}

function format(scaled: bigint): string {
  const digits = scaled.toString().padStart(5, '0')
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`
}

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'property-ltd' })

  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const entry = randomEntry(i)
    const result = await fixture.ledger.postEntry({ tenantId: tenant.id, ...entry })
    postedIds.push(result.entryId)
  }

  // Reverse roughly one entry in ten, which exercises the mirror-posting path
  // as part of the same property.
  for (const entryId of postedIds) {
    if (random() < 0.1) {
      await fixture.ledger.reverseEntry({ tenantId: tenant.id, entryId })
      reversedCount += 1
    }
  }
}, 120_000)

afterAll(async () => {
  await fixture.db.close()
})

describe(`property: ${ENTRY_COUNT} random entries (seed ${SEED})`, () => {
  it('posted every generated entry', async () => {
    expect(postedIds).toHaveLength(ENTRY_COUNT)
    expect(new Set(postedIds).size).toBe(ENTRY_COUNT)
    expect(reversedCount).toBeGreaterThan(10)

    const count = await fixture.db.asTenant(tenant.id, (session) =>
      session.one<{ entries: number; lines: number }>(
        `select (select count(*) from ledger.journal_entries)::int as entries,
                (select count(*) from ledger.journal_lines)::int as lines`,
      ),
    )
    expect(count.entries).toBe(ENTRY_COUNT + reversedCount)
    expect(count.lines).toBeGreaterThan(ENTRY_COUNT * 2)
  })

  it('has a trial balance that nets to exactly zero, per currency', async () => {
    const rows = await fixture.ledger.trialBalance(tenant.id, '2027-01-01T00:00:00Z')
    expect(rows.length).toBeGreaterThan(0)

    for (const currency of CURRENCIES) {
      const forCurrency = rows.filter((r) => r.currency === currency)
      expect(forCurrency.length).toBeGreaterThan(0)
      expect(sumMoney(forCurrency.map((r) => r.debits))).toBe(
        sumMoney(forCurrency.map((r) => r.credits)),
      )
      expect(sumMoney(forCurrency.map((r) => r.balance))).toBe('0.0000')
    }
  })

  it('satisfies the accounting equation in every currency', async () => {
    const rows = await fixture.ledger.accountingEquation(tenant.id, '2027-01-01T00:00:00Z')
    expect(rows.map((r) => r.currency).sort()).toEqual([...CURRENCIES].sort())
    for (const row of rows) {
      expect(row.difference).toBe('0.0000')
    }
  })

  it('has a cache that reconciles exactly with the journal', async () => {
    expect(await fixture.ledger.reconcileBalances(tenant.id)).toEqual([])
  })

  it('produces the same cache whether built incrementally or from scratch', async () => {
    const incremental = await fixture.ledger.currentBalances(tenant.id)

    await fixture.ledger.rebuildBalances(tenant.id)
    const rebuilt = await fixture.ledger.currentBalances(tenant.id)

    expect(rebuilt.map(({ updatedAt: _updatedAt, ...rest }) => rest)).toEqual(
      incremental.map(({ updatedAt: _updatedAt, ...rest }) => rest),
    )
  })

  it('agrees with the running balance of every account statement', async () => {
    // A third, independent path to the same number: the window function in
    // account_statement must land on what the cache holds.
    const cached = await fixture.ledger.currentBalances(tenant.id)
    expect(cached.length).toBeGreaterThan(10)

    for (const row of cached) {
      const statement = await fixture.ledger.statement(tenant.id, row.code)
      const last = statement.filter((s) => s.currency === row.currency).at(-1)
      expect(last?.runningBalance).toBe(row.normalAmount)
    }
  })

  it('rolls the tree up to the same totals the leaves hold', async () => {
    const sheet = await fixture.ledger.balanceSheet(tenant.id, '2027-01-01T00:00:00Z')

    for (const parent of sheet.filter((r) => !r.isLeaf)) {
      const leaves = sheet.filter(
        (r) =>
          r.isLeaf &&
          r.currency === parent.currency &&
          r.path.length > parent.path.length &&
          parent.path.every((segment, i) => r.path[i] === segment),
      )
      expect(sumMoney(leaves.map((l) => l.ownAmount))).toBe(parent.subtreeAmount)
    }
  })
})
