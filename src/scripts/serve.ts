/**
 * Runs the HTTP API.
 *
 *   npm run serve
 *
 * With no LEDGER_DATA_DIR the database is in-process and in-memory, which is
 * the right thing for a demo and the wrong thing for anything else; point that
 * variable at a directory to keep the books between restarts.
 *
 * There is no route that creates a tenant. Provisioning inserts into
 * ledger.tenants, which ledger_app has no INSERT on -- it runs as the
 * administrative role, which the API deliberately never assumes. So an empty
 * database gets one demo tenant here, and its id is logged for the reader who
 * wants to try the curl in the README.
 */

import { buildServer } from '../api/server.js'
import { Database } from '../database.js'
import { Ledger } from '../ledger.js'
import type { NewAccount } from '../types.js'

const DEMO_CHART: NewAccount[] = [
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

async function existingTenants(db: Database): Promise<{ id: string; slug: string }[]> {
  return db.admin((session) =>
    session.query<{ id: string; slug: string }>('select id, slug from ledger.tenants order by slug'),
  )
}

const dataDir = process.env.LEDGER_DATA_DIR
const db = await Database.create(dataDir === undefined ? {} : { dataDir })

let tenants = await existingTenants(db)
if (tenants.length === 0) {
  const ledger = new Ledger(db)
  const demo = await ledger.provisionTenant({
    slug: 'demo',
    name: 'Demo Company',
    baseCurrency: 'EUR',
  })
  await ledger.createAccounts(demo.id, DEMO_CHART)
  tenants = await existingTenants(db)
}

const app = buildServer(db)

for (const tenant of tenants) {
  app.log.info({ tenantId: tenant.id, slug: tenant.slug }, 'tenant available')
}

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  app.log.info({ signal }, 'shutting down')
  try {
    // Fastify stops accepting connections and waits for in-flight requests,
    // so the database outlives every transaction that is still running.
    await app.close()
    await db.close()
    process.exit(0)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

try {
  await app.listen({
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
  })
} catch (error) {
  app.log.error({ err: error }, 'failed to listen')
  await db.close()
  process.exit(1)
}
