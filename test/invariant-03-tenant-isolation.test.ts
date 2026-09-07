/**
 * Invariant #3 -- tenants cannot see or touch each other.
 *
 * sql/0090_security.sql: row-level security policies keyed on
 * ledger.current_tenant_id(), which reads the app.tenant_id GUC, plus FORCE
 * ROW LEVEL SECURITY so that the table owner is not exempt either.
 *
 * Cross-tenant *references* are a separate problem from cross-tenant *reads*:
 * PostgreSQL runs referential-integrity checks with row security bypassed, so
 * a policy alone would not stop a line pointing at another tenant's account.
 * The composite foreign keys in sql/0005_journal.sql are what close that.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CrossTenantReferenceError,
  TenantIsolationError,
  TenantMismatchError,
} from '../src/errors.js'
import { accountId, createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let alice: SeededTenant
let bob: SeededTenant
let bobEntryId: string

beforeAll(async () => {
  fixture = await createFixture()
  alice = await seedTenant(fixture.ledger, { slug: 'alice-ltd' })
  bob = await seedTenant(fixture.ledger, { slug: 'bob-gmbh' })

  await fixture.ledger.postEntry({
    tenantId: alice.id,
    idempotencyKey: 'alice-1',
    postedAt: new Date('2026-06-01T10:00:00Z'),
    description: 'Alice sells something',
    currency: 'EUR',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '1000.0000' },
      { accountCode: '4000', direction: 'credit', amount: '1000.0000' },
    ],
  })

  const bobEntry = await fixture.ledger.postEntry({
    tenantId: bob.id,
    idempotencyKey: 'bob-1',
    postedAt: new Date('2026-06-01T11:00:00Z'),
    description: "Bob's secret margin",
    currency: 'EUR',
    lines: [
      { accountCode: '1000', direction: 'debit', amount: '7777.0000' },
      { accountCode: '4000', direction: 'credit', amount: '7777.0000' },
    ],
  })
  bobEntryId = bobEntry.entryId
})

afterAll(async () => {
  await fixture.db.close()
})

describe('invariant 3: tenant isolation', () => {
  it('hides every tenant-scoped table from the other tenant', async () => {
    const visible = await fixture.db.asTenant(alice.id, async (session) => ({
      tenants: await session.query('select id from ledger.tenants'),
      accounts: await session.query('select id from ledger.accounts'),
      entries: await session.query('select id, description from ledger.journal_entries'),
      lines: await session.query('select id, amount from ledger.journal_lines'),
      balances: await session.query('select account_id from ledger.account_balances'),
    }))

    expect(visible.tenants.map((t) => t.id)).toEqual([alice.id])
    expect(visible.accounts).toHaveLength(16)
    expect(visible.entries).toHaveLength(1)
    expect(visible.entries[0]?.description).toBe('Alice sells something')
    expect(visible.lines.map((l) => l.amount)).toEqual(['1000.0000', '1000.0000'])
    expect(visible.balances).toHaveLength(2)
  })

  it('returns nothing for a direct query of the other tenant by primary key', async () => {
    // Not an error -- a policy makes the row simply not exist for this
    // session, which is exactly what "cannot read" should look like.
    const rows = await fixture.db.asTenant(alice.id, (session) =>
      session.query('select * from ledger.journal_entries where id = $1', [bobEntryId]),
    )
    expect(rows).toEqual([])
  })

  it('refuses a write that would create a row owned by another tenant', async () => {
    const attack = fixture.db.asTenant(alice.id, (session) =>
      session.query(
        `insert into ledger.accounts (tenant_id, code, name, type)
         values ($1, '9999', 'Planted account', 'asset')`,
        [bob.id],
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(TenantIsolationError)
    await expect(attack).rejects.toThrow(/row-level security/i)
  })

  it('refuses an UPDATE aimed at the other tenant, silently matching nothing', async () => {
    const before = await fixture.ledger.listAccounts(bob.id)

    const updated = await fixture.db.asTenant(alice.id, (session) =>
      session.query('update ledger.accounts set name = $1 where tenant_id = $2 returning id', [
        'defaced',
        bob.id,
      ]),
    )

    expect(updated).toEqual([])
    expect(await fixture.ledger.listAccounts(bob.id)).toEqual(before)
  })

  it('refuses a journal line that points at another tenant account', async () => {
    // The USING clause of a policy does not apply to foreign-key checks, so
    // this attack is stopped by the composite FK (tenant_id, account_id),
    // not by RLS.
    const bobsCash = await accountId(fixture.db, bob.id, '1000')

    const attack = fixture.db.asTenant(alice.id, async (session) => {
      const entry = await session.one<{ id: string }>(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'cross-tenant', now(), 'reaching over the fence', 'EUR')
         returning id`,
        [alice.id],
      )
      await session.query(
        `insert into ledger.journal_lines (tenant_id, entry_id, line_no, account_id, direction, amount, currency)
         values ($1, $2, 1, $3, 'debit', 1.0000, 'EUR')`,
        [alice.id, entry.id, bobsCash],
      )
    })

    await expect(attack).rejects.toBeInstanceOf(CrossTenantReferenceError)
  })

  it('is not bypassable by the role that owns the tables (FORCE ROW LEVEL SECURITY)', async () => {
    // Without FORCE, an owner ignores every policy. Since migrations,
    // maintenance jobs and SECURITY DEFINER functions all run as the owner,
    // that exemption would cover the code paths that touch the most rows.
    const asOwner = await fixture.db.asTenant(
      alice.id,
      async (session) => ({
        entries: await session.query('select id from ledger.journal_entries'),
        forced: await session.query<{ relname: string; relforcerowsecurity: boolean }>(
          `select relname, relforcerowsecurity
             from pg_class
            where relnamespace = 'ledger'::regnamespace
              and relrowsecurity
            order by relname`,
        ),
      }),
      { role: 'ledger_owner' },
    )

    expect(asOwner.entries).toHaveLength(1)
    expect(asOwner.forced.map((r) => r.relname)).toEqual([
      'account_balances',
      'accounting_periods',
      'accounts',
      'journal_entries',
      'journal_lines',
      'tenants',
    ])
    expect(asOwner.forced.every((r) => r.relforcerowsecurity)).toBe(true)
  })

  it('shows nothing at all to a session that forgot to identify its tenant', async () => {
    // app.tenant_id unset makes current_tenant_id() NULL, every policy
    // predicate NULL, and every table empty. Fail-closed.
    const rows = await fixture.db.asTenant('', async (session) => ({
      tenant: await session.query('select ledger.current_tenant_id() as tenant_id'),
      entries: await session.query('select id from ledger.journal_entries'),
      accounts: await session.query('select id from ledger.accounts'),
    }))

    expect(rows.tenant[0]?.tenant_id).toBeNull()
    expect(rows.entries).toEqual([])
    expect(rows.accounts).toEqual([])
  })

  it('refuses a report asked for a tenant the session is not scoped to', async () => {
    // The Ledger class always scopes the session to the tenant it was asked
    // about, so this can only be reached by a caller writing its own SQL --
    // which is precisely the caller worth defending against. Without the
    // guard the answer would be a plausible empty report, which is worse
    // than an error.
    for (const report of ['trial_balance', 'current_balances', 'reconcile_balances']) {
      const crossReport = fixture.db.asTenant(alice.id, (session) =>
        session.query(`select * from ledger.${report}($1)`, [bob.id]),
      )
      await expect(crossReport).rejects.toBeInstanceOf(TenantMismatchError)
      await expect(crossReport).rejects.toMatchObject({ sqlState: 'LG005' })
    }
  })

  it('refuses to post into another tenant even with a valid idempotency key', async () => {
    const attack = fixture.db.asTenant(alice.id, (session) =>
      session.query(
        `select * from ledger.post_entry($1, 'planted', now(), 'planted', 'EUR'::ledger.currency_code, '[]'::jsonb)`,
        [bob.id],
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(TenantMismatchError)
  })

  it("leaves the other tenant's books untouched after every attack", async () => {
    const bobBalances = await fixture.ledger.trialBalance(bob.id)
    expect(bobBalances.map((r) => [r.code, r.debits, r.credits])).toEqual([
      ['1000', '7777.0000', '0.0000'],
      ['4000', '0.0000', '7777.0000'],
    ])
  })
})
