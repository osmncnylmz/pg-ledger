/**
 * Domain types.
 *
 * Money is a `string`, never a `number`. PostgreSQL numeric(20,4) is an exact
 * decimal; IEEE-754 doubles are not, and the moment a balance passes through
 * one the books stop being auditable. The driver returns numeric as a string
 * and this layer keeps it that way all the way to the caller.
 */

export type Uuid = string

/** An exact decimal, as PostgreSQL rendered it. For example `"1234.5600"`. */
export type Money = string

/** ISO 4217 alphabetic code, for example `"EUR"`. */
export type CurrencyCode = string

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
export type NormalBalance = 'debit' | 'credit'
export type Direction = 'debit' | 'credit'
export type PeriodState = 'open' | 'closed'

export interface Tenant {
  id: Uuid
  slug: string
  name: string
  baseCurrency: CurrencyCode
  periodsRequired: boolean
  createdAt: Date
}

export interface Account {
  id: Uuid
  tenantId: Uuid
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  parentId: Uuid | null
  isActive: boolean
}

export interface AccountingPeriod {
  id: Uuid
  tenantId: Uuid
  name: string
  from: Date
  to: Date
  state: PeriodState
  closedAt: Date | null
}

export interface NewAccount {
  code: string
  name: string
  type: AccountType
  /** Code of the parent account. The parent must have the same account type. */
  parentCode?: string | null
  isActive?: boolean
}

export interface NewLine {
  accountCode: string
  direction: Direction
  /** Positive magnitude. Direction carries the sign. */
  amount: Money | number
  memo?: string | null
}

export interface PostEntryInput {
  tenantId: Uuid
  /** Unique per tenant. Posting the same key twice yields one entry. */
  idempotencyKey: string
  postedAt: Date | string
  description: string
  currency: CurrencyCode
  lines: NewLine[]
}

export interface PostEntryResult {
  entryId: Uuid
  /** False when the idempotency key already existed and this call was a replay. */
  created: boolean
}

export interface ReverseEntryInput {
  tenantId: Uuid
  entryId: Uuid
  postedAt?: Date | string
  description?: string
  idempotencyKey?: string
}

export interface JournalEntry {
  id: Uuid
  tenantId: Uuid
  idempotencyKey: string
  postedAt: Date
  description: string
  currency: CurrencyCode
  reversesEntryId: Uuid | null
  reversedByEntryId: Uuid | null
  isReversed: boolean
  createdAt: Date
}

export interface JournalLine {
  id: Uuid
  entryId: Uuid
  lineNo: number
  accountId: Uuid
  accountCode: string
  direction: Direction
  amount: Money
  currency: CurrencyCode
  memo: string | null
}

export interface JournalEntryWithLines extends JournalEntry {
  lines: JournalLine[]
}

export interface TrialBalanceRow {
  accountId: Uuid
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  currency: CurrencyCode
  debits: Money
  credits: Money
  /** Debit-positive: debits - credits. */
  balance: Money
  /** Positive when the account sits on its normal side. */
  normalAmount: Money
}

export interface StatementRow {
  postedAt: Date
  entryId: Uuid
  lineNo: number
  description: string
  memo: string | null
  currency: CurrencyCode
  direction: Direction
  debit: Money
  credit: Money
  signedAmount: Money
  /** Includes everything posted before `from`, so a statement opens correctly. */
  runningBalance: Money
}

export interface RollupRow {
  accountId: Uuid
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  depth: number
  path: string[]
  isLeaf: boolean
  currency: CurrencyCode
  ownAmount: Money
  subtreeAmount: Money
}

export interface AccountingEquationRow {
  currency: CurrencyCode
  assets: Money
  liabilities: Money
  equity: Money
  revenue: Money
  expenses: Money
  netIncome: Money
  /** assets - liabilities - equity - net income. Always exactly zero. */
  difference: Money
}

export interface CachedBalanceRow {
  accountId: Uuid
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  currency: CurrencyCode
  debitTotal: Money
  creditTotal: Money
  balance: Money
  normalAmount: Money
  lineCount: number
  updatedAt: Date
}

export interface ReconciliationRow {
  accountId: Uuid
  code: string | null
  currency: CurrencyCode
  cachedDebit: Money | null
  actualDebit: Money | null
  cachedCredit: Money | null
  actualCredit: Money | null
  cachedLineCount: number | null
  actualLineCount: number | null
}
