/**
 * Timings.
 *
 * What this measures is PGlite: PostgreSQL 18 compiled to WebAssembly, running
 * in-process on one connection. Same SQL a server would run, but it is not a
 * server -- no network round trip, no connection pool, no concurrency, and
 * WASM is meaningfully slower than a native build. The numbers are good for
 * comparing one query shape against another and useless as a production
 * throughput figure.
 *
 *   npm run bench
 */

import { Database } from '../database.js'
import { Ledger } from '../ledger.js'
import { loadMigrations } from '../migrations.js'
import type { NewAccount } from '../types.js'

const CHART: NewAccount[] = [
  { code: '1', name: 'Assets', type: 'asset' },
  { code: '1000', name: 'Cash', type: 'asset', parentCode: '1' },
  { code: '1100', name: 'Receivables', type: 'asset', parentCode: '1' },
  { code: '4', name: 'Revenue', type: 'revenue' },
  { code: '4000', name: 'Sales', type: 'revenue', parentCode: '4' },
  { code: '5', name: 'Expenses', type: 'expense' },
  { code: '5000', name: 'Costs', type: 'expense', parentCode: '5' },
]

const ENTRIES = 2000
const WIDE_LINES = 200
const REPORT_RUNS = 20

function ms(value: number): string {
  return `${value.toFixed(1)} ms`
}

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b)
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  console.log(
    `${label.padEnd(42)} mean ${ms(mean).padStart(9)}   p50 ${ms(p(0.5)).padStart(9)}   p95 ${ms(p(0.95)).padStart(9)}`,
  )
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const value = await fn()
  return [value, performance.now() - started]
}

async function main(): Promise<void> {
  console.log(`pg-ledger benchmark -- ${process.platform}/${process.arch}, node ${process.version}`)

  const [db, migrateMs] = await timed(() => Database.create())
  const ledger = new Ledger(db)
  // counted, not written down, so the line below cannot drift from sql/
  const migrationCount = (await loadMigrations()).length
  console.log(
    `\nschema bootstrap (initdb + ${migrationCount} migrations)`.padEnd(44) + `${ms(migrateMs)}`,
  )

  const version = await db.admin((s) => s.one<{ version: string }>('select version()'))
  console.log(version.version.split(',')[0])

  const tenant = await ledger.provisionTenant({
    slug: 'bench',
    name: 'Bench',
    baseCurrency: 'EUR',
  })
  await ledger.createAccounts(tenant.id, CHART)

  console.log(`\nposting ${ENTRIES} two-line entries, one transaction each`)
  const postSamples: number[] = []
  const startedAll = performance.now()
  for (let i = 0; i < ENTRIES; i += 1) {
    const [, elapsed] = await timed(() =>
      ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: `bench-${i}`,
        postedAt: new Date(Date.UTC(2026, i % 12, (i % 27) + 1, 12)),
        description: `Entry ${i}`,
        currency: 'EUR',
        lines: [
          { accountCode: '1000', direction: 'debit', amount: '10.0000' },
          { accountCode: '4000', direction: 'credit', amount: '10.0000' },
        ],
      }),
    )
    postSamples.push(elapsed)
  }
  const totalSeconds = (performance.now() - startedAll) / 1000
  report('postEntry (2 lines, own transaction)', postSamples)
  console.log(
    `${'throughput'.padEnd(42)} ${(ENTRIES / totalSeconds).toFixed(0)} entries/s, ` +
      `${((ENTRIES * 2) / totalSeconds).toFixed(0)} lines/s`,
  )

  console.log(`\nposting one ${WIDE_LINES}-line entry (statement-level cache trigger)`)
  const wideLines = [
    ...Array.from({ length: WIDE_LINES - 1 }, () => ({
      accountCode: '5000',
      direction: 'debit' as const,
      amount: '1.0000',
    })),
    { accountCode: '1000', direction: 'credit' as const, amount: `${WIDE_LINES - 1}.0000` },
  ]
  const [, wideMs] = await timed(() =>
    ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'bench-wide',
      postedAt: new Date(Date.UTC(2026, 6, 15, 12)),
      description: 'Wide entry',
      currency: 'EUR',
      lines: wideLines,
    }),
  )
  console.log(`${`postEntry (${WIDE_LINES} lines)`.padEnd(42)} ${ms(wideMs)}`)

  const counts = await db.asTenant(tenant.id, (s) =>
    s.one<{ entries: number; lines: number }>(
      `select (select count(*) from ledger.journal_entries)::int as entries,
              (select count(*) from ledger.journal_lines)::int as lines`,
    ),
  )
  console.log(`\njournal now holds ${counts.entries} entries / ${counts.lines} lines\n`)

  const reports: [string, () => Promise<unknown>][] = [
    ['trialBalance (full scan of the journal)', () => ledger.trialBalance(tenant.id)],
    ['currentBalances (cache read)', () => ledger.currentBalances(tenant.id)],
    ['reconcileBalances (cache vs recompute)', () => ledger.reconcileBalances(tenant.id)],
    ['balanceSheet (recursive CTE rollup)', () => ledger.balanceSheet(tenant.id)],
    ['statement of 1000 (window function)', () => ledger.statement(tenant.id, '1000')],
  ]

  for (const [label, run] of reports) {
    const samples: number[] = []
    for (let i = 0; i < REPORT_RUNS; i += 1) {
      const [, elapsed] = await timed(run)
      samples.push(elapsed)
    }
    report(label, samples)
  }

  const drift = await ledger.reconcileBalances(tenant.id)
  console.log(`\nreconciliation drift: ${drift.length} rows (0 means the cache is exact)`)

  await db.close()
}

await main()
