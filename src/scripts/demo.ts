/**
 * A runnable tour of the ledger.
 *
 * Starts an in-process PostgreSQL 18, applies the real migrations, keeps a
 * quarter of books for a small company, prints the reports and then tries --
 * and fails -- to corrupt them.
 *
 *   npm run demo
 */

import { Database } from '../database.js'
import { LedgerError } from '../errors.js'
import { Ledger } from '../ledger.js'
import type { NewAccount } from '../types.js'

const CHART: NewAccount[] = [
  { code: '1', name: 'Assets', type: 'asset' },
  { code: '1000', name: 'Cash at bank', type: 'asset', parentCode: '1' },
  { code: '1100', name: 'Accounts receivable', type: 'asset', parentCode: '1' },
  { code: '2', name: 'Liabilities', type: 'liability' },
  { code: '2100', name: 'VAT payable', type: 'liability', parentCode: '2' },
  { code: '3', name: 'Equity', type: 'equity' },
  { code: '3000', name: 'Share capital', type: 'equity', parentCode: '3' },
  { code: '4', name: 'Revenue', type: 'revenue' },
  { code: '4000', name: 'Consulting', type: 'revenue', parentCode: '4' },
  { code: '5', name: 'Operating expenses', type: 'expense' },
  { code: '5100', name: 'Salaries', type: 'expense', parentCode: '5' },
  { code: '5200', name: 'Office rent', type: 'expense', parentCode: '5' },
]

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${'-'.repeat(text.length)}`)
}

function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log('  (no rows)')
    return
  }

  const columns = Object.keys(rows[0] as Record<string, string>)
  const width = Object.fromEntries(
    columns.map((c) => [c, Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length))]),
  )
  const line = (cells: string[]): string =>
    '  ' + cells.map((cell, i) => cell.padEnd(width[columns[i] as string] ?? 0)).join('  ')

  console.log(line(columns))
  console.log('  ' + columns.map((c) => '-'.repeat(width[c] ?? 0)).join('  '))
  for (const row of rows) console.log(line(columns.map((c) => row[c] ?? '')))
}

async function refused(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt()
    console.log(`  NOT REFUSED  ${label}`)
  } catch (error) {
    if (error instanceof LedgerError) {
      console.log(`  refused      ${label}`)
      console.log(`               ${error.name} [${error.sqlState ?? '-'}] ${error.message}`)
      return
    }
    throw error
  }
}

async function main(): Promise<void> {
  const db = await Database.create()
  const ledger = new Ledger(db)

  const tenant = await ledger.provisionTenant({
    slug: 'northwind',
    name: 'Northwind Consulting',
    baseCurrency: 'EUR',
  })
  await ledger.createAccounts(tenant.id, CHART)
  await ledger.createPeriod(tenant.id, {
    name: '2026-Q1',
    from: '2026-01-01T00:00:00Z',
    to: '2026-04-01T00:00:00Z',
  })

  const entries = [
    {
      idempotencyKey: 'seed-round',
      postedAt: '2026-01-02T09:00:00Z',
      description: 'Share capital paid in',
      lines: [
        { accountCode: '1000', direction: 'debit' as const, amount: '75000.0000' },
        { accountCode: '3000', direction: 'credit' as const, amount: '75000.0000' },
      ],
    },
    {
      idempotencyKey: 'invoice-2026-001',
      postedAt: '2026-01-20T09:00:00Z',
      description: 'Invoice 2026-001, Contoso',
      lines: [
        { accountCode: '1100', direction: 'debit' as const, amount: '24200.0000' },
        { accountCode: '4000', direction: 'credit' as const, amount: '20000.0000' },
        { accountCode: '2100', direction: 'credit' as const, amount: '4200.0000' },
      ],
    },
    {
      idempotencyKey: 'invoice-2026-001-paid',
      postedAt: '2026-02-04T09:00:00Z',
      description: 'Invoice 2026-001 settled',
      lines: [
        { accountCode: '1000', direction: 'debit' as const, amount: '24200.0000' },
        { accountCode: '1100', direction: 'credit' as const, amount: '24200.0000' },
      ],
    },
    {
      idempotencyKey: 'salaries-2026-02',
      postedAt: '2026-02-27T09:00:00Z',
      description: 'February salaries',
      lines: [
        { accountCode: '5100', direction: 'debit' as const, amount: '18000.0000' },
        { accountCode: '1000', direction: 'credit' as const, amount: '18000.0000' },
      ],
    },
    {
      idempotencyKey: 'rent-2026-q1',
      postedAt: '2026-03-01T09:00:00Z',
      description: 'Q1 office rent',
      lines: [
        { accountCode: '5200', direction: 'debit' as const, amount: '6000.0000' },
        { accountCode: '1000', direction: 'credit' as const, amount: '6000.0000' },
      ],
    },
  ]

  for (const entry of entries) {
    await ledger.postEntry({ tenantId: tenant.id, currency: 'EUR', ...entry })
  }

  const asOf = '2026-03-31T23:59:59Z'

  heading('Trial balance as of 2026-03-31')
  table(
    (await ledger.trialBalance(tenant.id, asOf)).map((r) => ({
      code: r.code,
      account: r.name,
      debit: r.debits,
      credit: r.credits,
      'normal balance': `${r.normalAmount} ${r.currency}`,
    })),
  )

  heading('Balance sheet (recursive CTE rollup)')
  table(
    (await ledger.balanceSheet(tenant.id, asOf)).map((r) => ({
      account: `${'  '.repeat(r.depth)}${r.code} ${r.name}`,
      own: r.isLeaf ? r.ownAmount : '',
      subtotal: r.subtreeAmount,
    })),
  )

  heading('Income statement, Q1 2026')
  table(
    (await ledger.incomeStatement(tenant.id, '2026-01-01T00:00:00Z', asOf)).map((r) => ({
      account: `${'  '.repeat(r.depth)}${r.code} ${r.name}`,
      own: r.isLeaf ? r.ownAmount : '',
      subtotal: r.subtreeAmount,
    })),
  )

  heading('Cash at bank, statement with running balance (window function)')
  table(
    (await ledger.statement(tenant.id, '1000')).map((r) => ({
      date: r.postedAt.toISOString().slice(0, 10),
      description: r.description,
      debit: r.debit === '0.0000' ? '' : r.debit,
      credit: r.credit === '0.0000' ? '' : r.credit,
      balance: r.runningBalance,
    })),
  )

  heading('Accounting equation')
  table(
    (await ledger.accountingEquation(tenant.id, asOf)).map((r) => ({
      currency: r.currency,
      assets: r.assets,
      liabilities: r.liabilities,
      equity: r.equity,
      'net income': r.netIncome,
      difference: r.difference,
    })),
  )

  heading('Attacks on the books, all refused by the database')
  await refused('unbalanced entry (debits 100.00, credits 99.99)', () =>
    ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'attack-unbalanced',
      postedAt: '2026-03-15T09:00:00Z',
      description: 'Skimming a cent',
      currency: 'EUR',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '100.0000' },
        { accountCode: '4000', direction: 'credit', amount: '99.9900' },
      ],
    }),
  )

  await refused('hand-written UPDATE of a posted amount, as the table owner', () =>
    db.asTenant(tenant.id, (s) => s.query('update ledger.journal_lines set amount = 1'), {
      role: 'ledger_owner',
    }),
  )

  await refused('DELETE of the whole journal, as the table owner', () =>
    db.asTenant(tenant.id, (s) => s.query('delete from ledger.journal_entries'), {
      role: 'ledger_owner',
    }),
  )

  await refused('backdating into a closed period', async () => {
    await ledger.setPeriodState(tenant.id, '2026-Q1', 'closed')
    return ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'attack-backdate',
      postedAt: '2026-02-14T09:00:00Z',
      description: 'Squeezing revenue into a closed quarter',
      currency: 'EUR',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '5000.0000' },
        { accountCode: '4000', direction: 'credit', amount: '5000.0000' },
      ],
    })
  })

  await refused('mixing currencies inside one entry', () =>
    db.asTenant(tenant.id, async (s) => {
      const entry = await s.one<{ id: string }>(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'attack-currency', '2026-04-02T00:00:00Z', 'mixed', 'EUR') returning id`,
        [tenant.id],
      )
      const account = await s.one<{ id: string }>(
        "select id from ledger.accounts where tenant_id = $1 and code = '1000'",
        [tenant.id],
      )
      return s.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 1, $3, 'debit', 10, 'USD')`,
        [tenant.id, entry.id, account.id],
      )
    }),
  )

  heading('Corrections happen by reversal, never by edit')
  const salaries = await db.asTenant(tenant.id, (s) =>
    s.one<{ id: string }>(
      'select id from ledger.journal_entries where idempotency_key = $1',
      ['salaries-2026-02'],
    ),
  )
  await ledger.setPeriodState(tenant.id, '2026-Q1', 'open')
  const reversalId = await ledger.reverseEntry({
    tenantId: tenant.id,
    entryId: salaries.id,
    postedAt: '2026-03-20T09:00:00Z',
  })
  const original = await ledger.getEntry(tenant.id, salaries.id)
  const reversal = await ledger.getEntry(tenant.id, reversalId)
  console.log(`  original  ${original?.description} (untouched, reversed: ${original?.isReversed})`)
  console.log(`  reversal  ${reversal?.description}`)
  table(
    (reversal?.lines ?? []).map((l) => ({
      line: String(l.lineNo),
      account: l.accountCode,
      direction: l.direction,
      amount: l.amount,
    })),
  )

  heading('Balance cache reconciled against a full recomputation')
  const drift = await ledger.reconcileBalances(tenant.id)
  console.log(
    drift.length === 0
      ? '  no drift: the incremental cache equals a recomputation from the journal'
      : `  ${drift.length} accounts disagree`,
  )

  await db.close()
}

await main()
