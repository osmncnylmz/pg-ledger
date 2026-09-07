/**
 * The typed API over the schema.
 *
 * Shapes arguments and maps snake_case rows onto camelCase objects. What it
 * does not do is check the accounting: it never sums debits and credits, never
 * compares currencies, never asks whether a period is open, never looks at
 * whether an account has children. Those rules have one
 * implementation and it is in SQL. A copy here would drift, and a psql
 * session or someone else's Python worker would not run it anyway.
 *
 * Which is why the attack tests can bypass this class entirely, write raw
 * SQL, and still be refused.
 */

import type { Database, LedgerRole, Row } from './database.js'
import { AccountNotFoundError, PeriodNotFoundError } from './errors.js'
import type {
  Account,
  AccountingEquationRow,
  AccountingPeriod,
  CachedBalanceRow,
  JournalEntry,
  JournalEntryWithLines,
  NewAccount,
  PostEntryInput,
  PostEntryResult,
  ReconciliationRow,
  ReverseEntryInput,
  RollupRow,
  StatementRow,
  Tenant,
  TrialBalanceRow,
  Uuid,
} from './types.js'

export interface NewTenant {
  slug: string
  name: string
  baseCurrency: string
  periodsRequired?: boolean
}

export interface NewPeriod {
  name: string
  from: Date | string
  to: Date | string
  state?: 'open' | 'closed'
}

export interface EntryQuery {
  limit: number
  /**
   * Keyset cursor: return only entries strictly older than this one. Ordering
   * is (posted_at, id) descending, which matches
   * journal_entries_tenant_posted_at_idx read backwards, so a deep page costs
   * the same as the first one.
   */
  before?: { postedAt: Date | string; id: Uuid }
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function money(value: string | number): string {
  return typeof value === 'number' ? value.toString() : value
}

const asTenant = (r: Row): Tenant => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  baseCurrency: r.base_currency as string,
  periodsRequired: r.periods_required as boolean,
  createdAt: r.created_at as Date,
})

const asAccount = (r: Row): Account => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  code: r.code as string,
  name: r.name as string,
  type: r.type as Account['type'],
  normalBalance: r.normal_balance as Account['normalBalance'],
  parentId: (r.parent_id as string | null) ?? null,
  isActive: r.is_active as boolean,
})

const asPeriod = (r: Row): AccountingPeriod => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  name: r.name as string,
  from: r.lower as Date,
  to: r.upper as Date,
  state: r.state as AccountingPeriod['state'],
  closedAt: (r.closed_at as Date | null) ?? null,
})

const asEntry = (r: Row): JournalEntry => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  idempotencyKey: r.idempotency_key as string,
  postedAt: r.posted_at as Date,
  description: r.description as string,
  currency: r.currency as string,
  reversesEntryId: (r.reverses_entry_id as string | null) ?? null,
  reversedByEntryId: (r.reversed_by_entry_id as string | null) ?? null,
  isReversed: r.is_reversed as boolean,
  createdAt: r.created_at as Date,
})

const asTrialBalanceRow = (r: Row): TrialBalanceRow => ({
  accountId: r.account_id as string,
  code: r.code as string,
  name: r.name as string,
  type: r.type as TrialBalanceRow['type'],
  normalBalance: r.normal_balance as TrialBalanceRow['normalBalance'],
  currency: r.currency as string,
  debits: r.debits as string,
  credits: r.credits as string,
  balance: r.balance as string,
  normalAmount: r.normal_amount as string,
})

const asStatementRow = (r: Row): StatementRow => ({
  postedAt: r.posted_at as Date,
  entryId: r.entry_id as string,
  lineNo: r.line_no as number,
  description: r.description as string,
  memo: (r.memo as string | null) ?? null,
  currency: r.currency as string,
  direction: r.direction as StatementRow['direction'],
  debit: r.debit as string,
  credit: r.credit as string,
  signedAmount: r.signed_amount as string,
  runningBalance: r.running_balance as string,
})

const asRollupRow = (r: Row): RollupRow => ({
  accountId: r.account_id as string,
  code: r.code as string,
  name: r.name as string,
  type: r.type as RollupRow['type'],
  normalBalance: r.normal_balance as RollupRow['normalBalance'],
  depth: r.depth as number,
  path: r.path as string[],
  isLeaf: r.is_leaf as boolean,
  currency: r.currency as string,
  ownAmount: r.own_amount as string,
  subtreeAmount: r.subtree_amount as string,
})

const asEquationRow = (r: Row): AccountingEquationRow => ({
  currency: r.currency as string,
  assets: r.assets as string,
  liabilities: r.liabilities as string,
  equity: r.equity as string,
  revenue: r.revenue as string,
  expenses: r.expenses as string,
  netIncome: r.net_income as string,
  difference: r.difference as string,
})

const asCachedBalanceRow = (r: Row): CachedBalanceRow => ({
  accountId: r.account_id as string,
  code: r.code as string,
  name: r.name as string,
  type: r.type as CachedBalanceRow['type'],
  normalBalance: r.normal_balance as CachedBalanceRow['normalBalance'],
  currency: r.currency as string,
  debitTotal: r.debit_total as string,
  creditTotal: r.credit_total as string,
  balance: r.balance as string,
  normalAmount: r.normal_amount as string,
  lineCount: Number(r.line_count),
  updatedAt: r.updated_at as Date,
})

const asReconciliationRow = (r: Row): ReconciliationRow => ({
  accountId: r.account_id as string,
  code: (r.code as string | null) ?? null,
  currency: r.currency as string,
  cachedDebit: (r.cached_debit as string | null) ?? null,
  actualDebit: (r.actual_debit as string | null) ?? null,
  cachedCredit: (r.cached_credit as string | null) ?? null,
  actualCredit: (r.actual_credit as string | null) ?? null,
  cachedLineCount: r.cached_line_count === null ? null : Number(r.cached_line_count),
  actualLineCount: r.actual_line_count === null ? null : Number(r.actual_line_count),
})

export class Ledger {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  /** Creates a tenant. Runs as the administrative role; `ledger_app` cannot. */
  async provisionTenant(input: NewTenant): Promise<Tenant> {
    return this.db.admin(async (session) => {
      const row = await session.one(
        `insert into ledger.tenants (slug, name, base_currency, periods_required)
         values ($1, $2, $3::ledger.currency_code, $4)
         returning *`,
        [input.slug, input.name, input.baseCurrency, input.periodsRequired ?? false],
      )
      return asTenant(row)
    })
  }

  async getTenant(tenantId: Uuid): Promise<Tenant | undefined> {
    return this.db.asTenant(tenantId, async (session) => {
      const row = await session.maybeOne('select * from ledger.tenants where id = $1', [tenantId])
      return row === undefined ? undefined : asTenant(row)
    })
  }

  /**
   * Creates accounts in the order given, so a parent may be created in the
   * same call as its children.
   *
   * `parentCode` is resolved in its own statement rather than by a scalar
   * subquery inside the INSERT. A subquery that finds nothing yields NULL,
   * and NULL is a legal parent_id -- so a mistyped parent code would quietly
   * produce a root account instead of an error, and every rollup below it
   * would be wrong in a way no constraint can see.
   */
  async createAccounts(tenantId: Uuid, accounts: NewAccount[]): Promise<Account[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const created: Account[] = []

      for (const account of accounts) {
        let parentId: string | null = null

        if (account.parentCode !== undefined && account.parentCode !== null) {
          const parent = await session.maybeOne<{ id: string }>(
            'select id from ledger.accounts where tenant_id = $1 and code = $2',
            [tenantId, account.parentCode],
          )
          if (parent === undefined) {
            throw new AccountNotFoundError(
              `parent account ${account.parentCode} does not exist in this chart of accounts`,
              { code: 'LG012', detail: `tenant=${tenantId} code=${account.parentCode}` },
            )
          }
          parentId = parent.id
        }

        const row = await session.one(
          `insert into ledger.accounts (tenant_id, code, name, type, parent_id, is_active)
           values ($1, $2, $3, $4::ledger.account_type, $5, $6)
           returning *`,
          [
            tenantId,
            account.code,
            account.name,
            account.type,
            parentId,
            account.isActive ?? true,
          ],
        )
        created.push(asAccount(row))
      }

      return created
    })
  }

  async listAccounts(tenantId: Uuid): Promise<Account[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        'select * from ledger.accounts where tenant_id = $1 order by code',
        [tenantId],
      )
      return rows.map(asAccount)
    })
  }

  async setAccountActive(tenantId: Uuid, code: string, isActive: boolean): Promise<Account> {
    return this.db.asTenant(tenantId, async (session) => {
      const row = await session.maybeOne(
        `update ledger.accounts set is_active = $3
          where tenant_id = $1 and code = $2
          returning *`,
        [tenantId, code, isActive],
      )
      if (row === undefined) {
        throw new AccountNotFoundError(
          `account ${code} does not exist in this chart of accounts`,
          { code: 'LG012', detail: `tenant=${tenantId} code=${code}` },
        )
      }
      return asAccount(row)
    })
  }

  async createPeriod(tenantId: Uuid, period: NewPeriod): Promise<AccountingPeriod> {
    return this.db.asTenant(tenantId, async (session) => {
      const row = await session.one(
        `insert into ledger.accounting_periods (tenant_id, name, period, state)
         values ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::ledger.period_state)
         returning id, tenant_id, name, lower(period) as lower, upper(period) as upper, state, closed_at`,
        [
          tenantId,
          period.name,
          timestamp(period.from),
          timestamp(period.to),
          period.state ?? 'open',
        ],
      )
      return asPeriod(row)
    })
  }

  async setPeriodState(
    tenantId: Uuid,
    name: string,
    state: 'open' | 'closed',
  ): Promise<AccountingPeriod> {
    return this.db.asTenant(tenantId, async (session) => {
      const row = await session.maybeOne(
        `update ledger.accounting_periods set state = $3::ledger.period_state
          where tenant_id = $1 and name = $2
          returning id, tenant_id, name, lower(period) as lower, upper(period) as upper, state, closed_at`,
        [tenantId, name, state],
      )
      if (row === undefined) {
        throw new PeriodNotFoundError(`no accounting period named ${name} in this tenant`, {
          code: 'LG004',
          detail: `tenant=${tenantId} name=${name}`,
        })
      }
      return asPeriod(row)
    })
  }

  async listPeriods(tenantId: Uuid): Promise<AccountingPeriod[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        `select id, tenant_id, name, lower(period) as lower, upper(period) as upper, state, closed_at
           from ledger.accounting_periods
          where tenant_id = $1
          order by lower(period)`,
        [tenantId],
      )
      return rows.map(asPeriod)
    })
  }

  /**
   * Posts one journal entry.
   *
   * Idempotent on (tenantId, idempotencyKey): a replay returns the original
   * entry id with `created: false` and writes nothing.
   *
   * Note what is missing: no check that the lines balance. The deferred
   * constraint trigger raises at COMMIT, which is inside `asTenant`, so an
   * unbalanced entry still throws `UnbalancedEntryError` from this call --
   * the rule is simply not implemented twice.
   */
  async postEntry(input: PostEntryInput): Promise<PostEntryResult> {
    const lines = input.lines.map((line) => ({
      account_code: line.accountCode,
      direction: line.direction,
      amount: money(line.amount),
      memo: line.memo ?? null,
    }))

    return this.db.asTenant(input.tenantId, async (session) => {
      const row = await session.one<{ entry_id: string; created: boolean }>(
        `select entry_id, created
           from ledger.post_entry($1, $2, $3::timestamptz, $4, $5::ledger.currency_code, $6::jsonb)`,
        [
          input.tenantId,
          input.idempotencyKey,
          timestamp(input.postedAt),
          input.description,
          input.currency,
          JSON.stringify(lines),
        ],
      )
      return { entryId: row.entry_id, created: row.created }
    })
  }

  /** Posts the mirror of an entry. The original row is never modified. */
  async reverseEntry(input: ReverseEntryInput): Promise<Uuid> {
    return this.db.asTenant(input.tenantId, async (session) => {
      const row = await session.one<{ id: string }>(
        'select ledger.reverse_entry($1, $2::timestamptz, $3, $4) as id',
        [
          input.entryId,
          input.postedAt === undefined ? null : timestamp(input.postedAt),
          input.description ?? null,
          input.idempotencyKey ?? null,
        ],
      )
      return row.id
    })
  }

  async getEntry(tenantId: Uuid, entryId: Uuid): Promise<JournalEntryWithLines | undefined> {
    return this.db.asTenant(tenantId, async (session) => {
      const entry = await session.maybeOne(
        'select * from ledger.journal_entry_status where id = $1',
        [entryId],
      )
      if (entry === undefined) return undefined

      const lines = await session.query(
        `select l.*, a.code as account_code
           from ledger.journal_lines l
           join ledger.accounts a on a.id = l.account_id
          where l.entry_id = $1
          order by l.line_no`,
        [entryId],
      )

      return {
        ...asEntry(entry),
        lines: lines.map((l) => ({
          id: l.id as string,
          entryId: l.entry_id as string,
          lineNo: l.line_no as number,
          accountId: l.account_id as string,
          accountCode: l.account_code as string,
          direction: l.direction as 'debit' | 'credit',
          amount: l.amount as string,
          currency: l.currency as string,
          memo: (l.memo as string | null) ?? null,
        })),
      }
    })
  }

  async listEntries(tenantId: Uuid, query: EntryQuery): Promise<JournalEntry[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const before = query.before
      const rows =
        before === undefined
          ? await session.query(
              `select * from ledger.journal_entry_status
                where tenant_id = $1
                order by posted_at desc, id desc
                limit $2`,
              [tenantId, query.limit],
            )
          : await session.query(
              `select * from ledger.journal_entry_status
                where tenant_id = $1
                  and (posted_at, id) < ($3::timestamptz, $4::uuid)
                order by posted_at desc, id desc
                limit $2`,
              [tenantId, query.limit, timestamp(before.postedAt), before.id],
            )
      return rows.map(asEntry)
    })
  }

  async trialBalance(tenantId: Uuid, asOf: Date | string = new Date()): Promise<TrialBalanceRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        'select * from ledger.trial_balance($1, $2::timestamptz)',
        [tenantId, timestamp(asOf)],
      )
      return rows.map(asTrialBalanceRow)
    })
  }

  async statement(
    tenantId: Uuid,
    accountCode: string,
    range: { from?: Date | string; to?: Date | string } = {},
  ): Promise<StatementRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        `select * from ledger.account_statement(
           $1, $2,
           coalesce($3::timestamptz, '-infinity'::timestamptz),
           coalesce($4::timestamptz, 'infinity'::timestamptz))`,
        [
          tenantId,
          accountCode,
          range.from === undefined ? null : timestamp(range.from),
          range.to === undefined ? null : timestamp(range.to),
        ],
      )
      return rows.map(asStatementRow)
    })
  }

  async balanceSheet(tenantId: Uuid, asOf: Date | string = new Date()): Promise<RollupRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        'select * from ledger.balance_sheet($1, $2::timestamptz)',
        [tenantId, timestamp(asOf)],
      )
      return rows.map(asRollupRow)
    })
  }

  async incomeStatement(
    tenantId: Uuid,
    from: Date | string,
    to: Date | string,
  ): Promise<RollupRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        'select * from ledger.income_statement($1, $2::timestamptz, $3::timestamptz)',
        [tenantId, timestamp(from), timestamp(to)],
      )
      return rows.map(asRollupRow)
    })
  }

  async accountingEquation(
    tenantId: Uuid,
    asOf: Date | string = new Date(),
  ): Promise<AccountingEquationRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query(
        'select * from ledger.accounting_equation($1, $2::timestamptz)',
        [tenantId, timestamp(asOf)],
      )
      return rows.map(asEquationRow)
    })
  }

  async currentBalances(tenantId: Uuid): Promise<CachedBalanceRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query('select * from ledger.current_balances($1)', [tenantId])
      return rows.map(asCachedBalanceRow)
    })
  }

  /** Empty means the incremental cache agrees exactly with the journal. */
  async reconcileBalances(tenantId: Uuid): Promise<ReconciliationRow[]> {
    return this.db.asTenant(tenantId, async (session) => {
      const rows = await session.query('select * from ledger.reconcile_balances($1)', [tenantId])
      return rows.map(asReconciliationRow)
    })
  }

  /** Drops and recomputes the cache from the journal. Returns rows written. */
  async rebuildBalances(tenantId: Uuid, role: LedgerRole = 'ledger_app'): Promise<number> {
    return this.db.asTenant(
      tenantId,
      async (session) => {
        const row = await session.one<{ rebuild_balances: number | string }>(
          'select ledger.rebuild_balances($1) as rebuild_balances',
          [tenantId],
        )
        return Number(row.rebuild_balances)
      },
      { role },
    )
  }
}
