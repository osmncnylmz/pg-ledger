import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ClosedPeriodError,
  NoOpenPeriodError,
  OverlappingPeriodError,
  PeriodNotFoundError,
} from '../src/errors.js'
import { createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant
let strict: SeededTenant

const JANUARY = { name: '2026-01', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }
const FEBRUARY = { name: '2026-02', from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }

function sale(key: string, postedAt: string) {
  return {
    idempotencyKey: key,
    postedAt,
    description: 'Sale',
    currency: 'EUR',
    lines: [
      { accountCode: '1000', direction: 'debit' as const, amount: '10.0000' },
      { accountCode: '4000', direction: 'credit' as const, amount: '10.0000' },
    ],
  }
}

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'periodic-ltd' })
  strict = await seedTenant(fixture.ledger, { slug: 'strict-ltd', periodsRequired: true })

  await fixture.ledger.createPeriod(tenant.id, JANUARY)
  await fixture.ledger.createPeriod(tenant.id, FEBRUARY)
  await fixture.ledger.createPeriod(strict.id, JANUARY)
})

afterAll(async () => {
  await fixture.db.close()
})

describe('invariant 4: closed periods', () => {
  it('accepts a posting into an open period', async () => {
    const result = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('january-open', '2026-01-15T12:00:00Z'),
    })
    expect(result.created).toBe(true)
  })

  it('refuses a posting into a closed period', async () => {
    await fixture.ledger.setPeriodState(tenant.id, '2026-01', 'closed')

    const attack = fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('january-backdated', '2026-01-31T23:59:59Z'),
    })

    await expect(attack).rejects.toBeInstanceOf(ClosedPeriodError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG003' })
    await expect(attack).rejects.toThrow(/period 2026-01 is closed/)
  })

  it('refuses it for raw SQL too, not just the posting function', async () => {
    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query(
        `insert into ledger.journal_entries (tenant_id, idempotency_key, posted_at, description, currency)
         values ($1, 'raw-backdate', '2026-01-10T00:00:00Z', 'sneaking in', 'EUR')`,
        [tenant.id],
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(ClosedPeriodError)
  })

  it('still accepts postings into the periods that remain open', async () => {
    const result = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('february-open', '2026-02-10T12:00:00Z'),
    })
    expect(result.created).toBe(true)
  })

  it('accepts the backdated entry again once the period is reopened', async () => {
    await fixture.ledger.setPeriodState(tenant.id, '2026-01', 'open')

    const result = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('january-after-reopen', '2026-01-20T12:00:00Z'),
    })
    expect(result.created).toBe(true)

    const [period] = await fixture.ledger.listPeriods(tenant.id)
    expect(period?.state).toBe('open')
    expect(period?.closedAt).toBeNull()
  })

  it('refuses a reversal that would land in a closed period', async () => {
    const posted = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('to-be-reversed', '2026-02-11T12:00:00Z'),
    })
    await fixture.ledger.setPeriodState(tenant.id, '2026-02', 'closed')

    await expect(
      fixture.ledger.reverseEntry({
        tenantId: tenant.id,
        entryId: posted.entryId,
        postedAt: '2026-02-12T12:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ClosedPeriodError)

    // Reversing into an open period is the correct accounting answer.
    const reversalId = await fixture.ledger.reverseEntry({
      tenantId: tenant.id,
      entryId: posted.entryId,
      postedAt: '2026-01-25T12:00:00Z',
    })
    expect(reversalId).toMatch(/^[0-9a-f-]{36}$/)

    await fixture.ledger.setPeriodState(tenant.id, '2026-02', 'open')
  })

  it('allows posting outside every period unless the tenant requires them', async () => {
    const result = await fixture.ledger.postEntry({
      tenantId: tenant.id,
      ...sale('no-period-covers-this', '2027-07-01T12:00:00Z'),
    })
    expect(result.created).toBe(true)
  })

  it('refuses posting outside every period when the tenant requires them', async () => {
    const attack = fixture.ledger.postEntry({
      tenantId: strict.id,
      ...sale('outside-calendar', '2026-05-01T12:00:00Z'),
    })

    await expect(attack).rejects.toBeInstanceOf(NoOpenPeriodError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG006' })
  })

  it('makes overlapping periods structurally impossible', async () => {
    // An exclusion constraint, not a read-then-write trigger: two concurrent
    // writers cannot both look, see nothing, and insert.
    const attack = fixture.ledger.createPeriod(tenant.id, {
      name: '2026-Q1',
      from: '2026-01-15T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    })

    await expect(attack).rejects.toBeInstanceOf(OverlappingPeriodError)
    await expect(attack).rejects.toMatchObject({ sqlState: '23P01' })
  })

  it('allows an adjacent, non-overlapping period', async () => {
    const march = await fixture.ledger.createPeriod(tenant.id, {
      name: '2026-03',
      from: '2026-03-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    })
    expect(march.state).toBe('open')
  })

  it('allows a different tenant to use the same period range', async () => {
    const period = await fixture.ledger.createPeriod(strict.id, FEBRUARY)
    expect(period.name).toBe('2026-02')
  })

  it('stamps closed_at when a period closes and clears it when it reopens', async () => {
    const closed = await fixture.ledger.setPeriodState(tenant.id, '2026-03', 'closed')
    expect(closed.closedAt).toBeInstanceOf(Date)

    const reopened = await fixture.ledger.setPeriodState(tenant.id, '2026-03', 'open')
    expect(reopened.closedAt).toBeNull()
  })

  it('refuses an unbounded or empty period', async () => {
    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query(
          `insert into ledger.accounting_periods (tenant_id, name, period)
           values ($1, 'forever', tstzrange(null, null))`,
          [tenant.id],
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'accounting_periods_bounded' })

    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query(
          `insert into ledger.accounting_periods (tenant_id, name, period)
           values ($1, 'nothing', tstzrange('2026-09-01', '2026-09-01'))`,
          [tenant.id],
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'accounting_periods_bounded' })
  })

  it('names the refusal when the period to close does not exist', async () => {
    // A mistyped period name must not look like a successful close.
    await expect(
      fixture.ledger.setPeriodState(tenant.id, '2026-13', 'closed'),
    ).rejects.toBeInstanceOf(PeriodNotFoundError)
  })
})
