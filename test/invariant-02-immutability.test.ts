/**
 * Invariant #2 -- the journal is append-only. Triggers in
 * sql/0007_immutability.sql, withheld grants in sql/0090_security.sql.
 *
 * The interesting attacks run as `ledger_owner`, the role that owns the
 * tables. It holds every privilege on them, so a refusal here cannot be blamed
 * on a missing GRANT: it is the trigger, and a trigger cannot be granted away.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ImmutableJournalError, InsufficientPrivilegeError } from '../src/errors.js'
import { createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant
let entryId: string

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger)

  const posted = await fixture.ledger.postEntry({
    tenantId: tenant.id,
    idempotencyKey: 'original',
    postedAt: new Date('2026-05-01T10:00:00Z'),
    description: 'Consulting fee',
    currency: 'EUR',
    lines: [
      { accountCode: '1100', direction: 'debit', amount: '2400.0000' },
      { accountCode: '4100', direction: 'credit', amount: '2400.0000' },
    ],
  })
  entryId = posted.entryId
})

afterAll(async () => {
  await fixture.db.close()
})

describe('invariant 2: immutability', () => {
  it('refuses UPDATE on a posted entry even for the table owner', async () => {
    const attack = fixture.db.asTenant(
      tenant.id,
      (session) =>
        session.query('update ledger.journal_entries set description = $1 where id = $2', [
          'nothing to see here',
          entryId,
        ]),
      { role: 'ledger_owner' },
    )

    await expect(attack).rejects.toBeInstanceOf(ImmutableJournalError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG002' })
    await expect(attack).rejects.toThrow(/append-only: UPDATE/)
  })

  it('refuses UPDATE of an amount even for the table owner', async () => {
    const attack = fixture.db.asTenant(
      tenant.id,
      (session) => session.query('update ledger.journal_lines set amount = amount * 10'),
      { role: 'ledger_owner' },
    )

    await expect(attack).rejects.toBeInstanceOf(ImmutableJournalError)
  })

  it('refuses DELETE on entries and lines even for the table owner', async () => {
    await expect(
      fixture.db.asTenant(
        tenant.id,
        (session) => session.query('delete from ledger.journal_lines'),
        { role: 'ledger_owner' },
      ),
    ).rejects.toBeInstanceOf(ImmutableJournalError)

    await expect(
      fixture.db.asTenant(
        tenant.id,
        (session) => session.query('delete from ledger.journal_entries'),
        { role: 'ledger_owner' },
      ),
    ).rejects.toBeInstanceOf(ImmutableJournalError)
  })

  it('refuses TRUNCATE, which row-level triggers would not see', async () => {
    for (const table of ['ledger.journal_lines', 'ledger.journal_entries']) {
      await expect(
        fixture.db.asTenant(tenant.id, (session) => session.exec(`truncate ${table} cascade`), {
          role: 'ledger_owner',
        }),
      ).rejects.toBeInstanceOf(ImmutableJournalError)
    }
  })

  it('does not even grant the application role permission to try', async () => {
    // the grant is the fence; 0007's trigger is the wall behind it
    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query('delete from ledger.journal_entries where id = $1', [entryId]),
    )

    await expect(attack).rejects.toBeInstanceOf(InsufficientPrivilegeError)
    await expect(attack).rejects.toMatchObject({ sqlState: '42501' })
  })

  it('leaves the entry intact after every attack', async () => {
    const entry = await fixture.ledger.getEntry(tenant.id, entryId)
    expect(entry?.description).toBe('Consulting fee')
    expect(entry?.lines.map((l) => l.amount)).toEqual(['2400.0000', '2400.0000'])
  })

  it('corrects a posted entry only through a reversing entry', async () => {
    const reversalId = await fixture.ledger.reverseEntry({
      tenantId: tenant.id,
      entryId,
      postedAt: new Date('2026-05-02T10:00:00Z'),
    })

    const original = await fixture.ledger.getEntry(tenant.id, entryId)
    const reversal = await fixture.ledger.getEntry(tenant.id, reversalId)

    // The original row was never written to; the link lives on the new entry
    // and is read back through a view.
    expect(original?.isReversed).toBe(true)
    expect(original?.reversedByEntryId).toBe(reversalId)
    expect(reversal?.reversesEntryId).toBe(entryId)
    expect(reversal?.description).toBe('Reversal of: Consulting fee')

    expect(reversal?.lines.map((l) => [l.accountCode, l.direction, l.amount])).toEqual([
      ['1100', 'credit', '2400.0000'],
      ['4100', 'debit', '2400.0000'],
    ])

    const balances = await fixture.ledger.trialBalance(tenant.id)
    for (const row of balances) {
      expect(row.balance).toBe('0.0000')
    }
  })

  it('refuses to reverse the same entry twice', async () => {
    await expect(
      fixture.ledger.reverseEntry({ tenantId: tenant.id, entryId }),
    ).rejects.toMatchObject({ sqlState: 'LG009' })
  })

  it('refuses a hand-written second reversal that skips the function', async () => {
    // The function raises LG009, but the unique constraint on
    // (tenant_id, reverses_entry_id) is what makes it impossible.
    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query(
        `insert into ledger.journal_entries
           (tenant_id, idempotency_key, posted_at, description, currency, reverses_entry_id)
         values ($1, 'sneaky-reversal', now(), 'second reversal', 'EUR', $2)`,
        [tenant.id, entryId],
      ),
    )

    await expect(attack).rejects.toMatchObject({ sqlState: '23505' })
  })
})
