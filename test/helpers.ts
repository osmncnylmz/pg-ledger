/**
 * Test fixtures.
 *
 * Every test file gets its own in-process PostgreSQL 18 (PGlite) with the real
 * migrations applied: the same SQL a server deployment would run. No mocks, no
 * "unit tested the query builder".
 */

import { Database } from '../src/database.js'
import { Ledger } from '../src/ledger.js'
import type { NewAccount, Uuid } from '../src/types.js'

export interface Fixture {
  db: Database
  ledger: Ledger
}

export async function createFixture(): Promise<Fixture> {
  const db = await Database.create()
  return { db, ledger: new Ledger(db) }
}

/** A small but realistic chart of accounts: three levels, all five types. */
export const CHART_OF_ACCOUNTS: NewAccount[] = [
  { code: '1', name: 'Assets', type: 'asset' },
  { code: '1000', name: 'Cash', type: 'asset', parentCode: '1' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', parentCode: '1' },
  { code: '1200', name: 'Inventory', type: 'asset', parentCode: '1' },
  { code: '2', name: 'Liabilities', type: 'liability' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', parentCode: '2' },
  { code: '2100', name: 'VAT Payable', type: 'liability', parentCode: '2' },
  { code: '3', name: 'Equity', type: 'equity' },
  { code: '3000', name: 'Share Capital', type: 'equity', parentCode: '3' },
  { code: '4', name: 'Revenue', type: 'revenue' },
  { code: '4000', name: 'Product Sales', type: 'revenue', parentCode: '4' },
  { code: '4100', name: 'Service Revenue', type: 'revenue', parentCode: '4' },
  { code: '5', name: 'Operating Expenses', type: 'expense' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', parentCode: '5' },
  { code: '5100', name: 'Salaries', type: 'expense', parentCode: '5' },
  { code: '5200', name: 'Rent', type: 'expense', parentCode: '5' },
]

/** The leaves, which are the only codes a posting may name. */
export const LEAF_CODES = CHART_OF_ACCOUNTS.filter((a) => a.parentCode !== undefined).map(
  (a) => a.code,
)

let slugCounter = 0

export interface SeededTenant {
  id: Uuid
  slug: string
}

export async function seedTenant(
  ledger: Ledger,
  options: {
    slug?: string
    baseCurrency?: string
    periodsRequired?: boolean
    accounts?: NewAccount[]
  } = {},
): Promise<SeededTenant> {
  slugCounter += 1
  const slug = options.slug ?? `tenant-${slugCounter}`

  const tenant = await ledger.provisionTenant({
    slug,
    name: slug,
    baseCurrency: options.baseCurrency ?? 'EUR',
    periodsRequired: options.periodsRequired ?? false,
  })

  await ledger.createAccounts(tenant.id, options.accounts ?? CHART_OF_ACCOUNTS)

  return { id: tenant.id, slug }
}

/** Resolves an account code to its uuid, for tests that write raw SQL. */
export async function accountId(db: Database, tenantId: Uuid, code: string): Promise<Uuid> {
  return db.asTenant(tenantId, async (session) => {
    const row = await session.one<{ id: string }>(
      'select id from ledger.accounts where tenant_id = $1 and code = $2',
      [tenantId, code],
    )
    return row.id
  })
}

/** Deterministic PRNG, so a property-test failure is reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Exact decimal addition over the string amounts the driver returns. */
export function sumMoney(values: readonly string[]): string {
  const total = values.reduce((acc, value) => acc + BigInt(toScaledInteger(value)), 0n)
  return fromScaledInteger(total)
}

const SCALE = 4

function toScaledInteger(value: string): bigint {
  const negative = value.startsWith('-')
  const digits = negative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = digits.split('.')
  const padded = (fraction + '0'.repeat(SCALE)).slice(0, SCALE)
  const scaled = BigInt(whole + padded)
  return negative ? -scaled : scaled
}

function fromScaledInteger(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0')
  const whole = digits.slice(0, -SCALE)
  const fraction = digits.slice(-SCALE)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}
