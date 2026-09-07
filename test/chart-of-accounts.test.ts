/**
 * The chart of accounts defends its own shape.
 *
 * Spread over three migrations: 0003 carries the generated normal_balance
 * column, the three-column self foreign key and the cycle constraint trigger;
 * 0009 keeps postings on the leaves; 0013 freezes the type of an account that
 * has been posted to.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AccountCycleError,
  AccountNotFoundError,
  AccountTypeLockedError,
  InactiveAccountError,
  RollupAccountError,
} from '../src/errors.js'
import { accountId, createFixture, seedTenant, type Fixture, type SeededTenant } from './helpers.js'

let fixture: Fixture
let tenant: SeededTenant

beforeAll(async () => {
  fixture = await createFixture()
  tenant = await seedTenant(fixture.ledger, { slug: 'chart-ltd' })
})

afterAll(async () => {
  await fixture.db.close()
})

describe('normal balance', () => {
  it('is derived from the account type and cannot be written', async () => {
    const accounts = await fixture.ledger.listAccounts(tenant.id)
    const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]))

    expect(byCode['1000']?.normalBalance).toBe('debit') // asset
    expect(byCode['2000']?.normalBalance).toBe('credit') // liability
    expect(byCode['3000']?.normalBalance).toBe('credit') // equity
    expect(byCode['4000']?.normalBalance).toBe('credit') // revenue
    expect(byCode['5000']?.normalBalance).toBe('debit') // expense

    // A STORED GENERATED column rejects the write outright, so the derived
    // value cannot drift from the type it is derived from.
    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query("update ledger.accounts set normal_balance = 'credit' where code = '1000'"),
      ),
    ).rejects.toMatchObject({ code: '428C9' })
  })
})

describe('the account tree', () => {
  it('refuses a parent of a different account type', async () => {
    // The three-column self FK ties (tenant_id, parent_id, type) to
    // (tenant_id, id, type): a revenue account cannot hang off an asset.
    await expect(
      fixture.ledger.createAccounts(tenant.id, [
        { code: '4900', name: 'Misfiled revenue', type: 'revenue', parentCode: '1' },
      ]),
    ).rejects.toMatchObject({ constraint: 'accounts_parent_same_tenant_and_type' })
  })

  it('refuses an account that is its own parent', async () => {
    await expect(
      fixture.db.asTenant(tenant.id, (session) =>
        session.query('update ledger.accounts set parent_id = id where code = $1', ['1000']),
      ),
    ).rejects.toMatchObject({ constraint: 'accounts_not_own_parent' })
  })

  it('refuses a cycle built out of two legal-looking updates', async () => {
    await fixture.ledger.createAccounts(tenant.id, [
      { code: '6', name: 'Other expenses', type: 'expense' },
      { code: '6100', name: 'Bank charges', type: 'expense', parentCode: '6' },
    ])

    const parent = await accountId(fixture.db, tenant.id, '6')
    const child = await accountId(fixture.db, tenant.id, '6100')

    // Point the parent at its own child: each row on its own looks fine, and
    // the FK is satisfied. Only walking the chain finds the loop.
    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query('update ledger.accounts set parent_id = $2 where id = $1', [parent, child]),
    )

    await expect(attack).rejects.toBeInstanceOf(AccountCycleError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG010' })
  })

  it('keeps duplicate codes out, per tenant', async () => {
    await expect(
      fixture.ledger.createAccounts(tenant.id, [
        { code: '1000', name: 'Second cash account', type: 'asset', parentCode: '1' },
      ]),
    ).rejects.toMatchObject({ constraint: 'accounts_tenant_code_key' })
  })
})

describe('postable accounts', () => {
  it('refuses a posting to an account that has children', async () => {
    const attack = fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'post-to-rollup',
      postedAt: new Date('2026-09-01T00:00:00Z'),
      description: 'Posting to a subtotal',
      currency: 'EUR',
      lines: [
        { accountCode: '1', direction: 'debit', amount: '10.0000' },
        { accountCode: '4000', direction: 'credit', amount: '10.0000' },
      ],
    })

    await expect(attack).rejects.toBeInstanceOf(RollupAccountError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG007' })
  })

  it('refuses to nest accounts under one that already has postings', async () => {
    // The same rule from the other direction: a leaf with postings cannot
    // quietly become a rollup and make every subtotal ambiguous.
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'fill-1000',
      postedAt: new Date('2026-09-02T00:00:00Z'),
      description: 'Opening cash',
      currency: 'EUR',
      lines: [
        { accountCode: '1000', direction: 'debit', amount: '100.0000' },
        { accountCode: '3000', direction: 'credit', amount: '100.0000' },
      ],
    })

    await expect(
      fixture.ledger.createAccounts(tenant.id, [
        { code: '1001', name: 'Petty cash', type: 'asset', parentCode: '1000' },
      ]),
    ).rejects.toBeInstanceOf(RollupAccountError)
  })

  it('refuses a posting to an account that does not exist', async () => {
    await expect(
      fixture.ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: 'ghost-account',
        postedAt: new Date('2026-09-03T00:00:00Z'),
        description: 'To nowhere',
        currency: 'EUR',
        lines: [
          { accountCode: '9999', direction: 'debit', amount: '1.0000' },
          { accountCode: '4000', direction: 'credit', amount: '1.0000' },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError)
  })

  it('refuses a posting to a deactivated account', async () => {
    await fixture.ledger.setAccountActive(tenant.id, '5200', false)

    await expect(
      fixture.ledger.postEntry({
        tenantId: tenant.id,
        idempotencyKey: 'inactive-account',
        postedAt: new Date('2026-09-04T00:00:00Z'),
        description: 'Rent on a closed account',
        currency: 'EUR',
        lines: [
          { accountCode: '5200', direction: 'debit', amount: '1.0000' },
          { accountCode: '1000', direction: 'credit', amount: '1.0000' },
        ],
      }),
    ).rejects.toBeInstanceOf(InactiveAccountError)

    await fixture.ledger.setAccountActive(tenant.id, '5200', true)
  })

  it('refuses a parent code that is not in the chart of accounts', async () => {
    // The schema cannot catch this one: the row a typo produces is a perfectly
    // legal root account. See createAccounts in src/ledger.ts for why the
    // parent lookup is its own statement.
    await expect(
      fixture.ledger.createAccounts(tenant.id, [
        { code: '1500', name: 'Prepayments', type: 'asset', parentCode: '1-typo' },
      ]),
    ).rejects.toBeInstanceOf(AccountNotFoundError)

    // ... and nothing was written.
    const codes = (await fixture.ledger.listAccounts(tenant.id)).map((a) => a.code)
    expect(codes).not.toContain('1500')
  })

  it('names the refusal when an account to deactivate does not exist', async () => {
    await expect(
      fixture.ledger.setAccountActive(tenant.id, '9999', false),
    ).rejects.toBeInstanceOf(AccountNotFoundError)
  })
})

describe('an account that has been posted to', () => {
  // Reclassifying re-signs an account's whole history, because normal_balance
  // is generated from type. The self FK already refuses the easy version of
  // this attack; the two below are the ones it is blind to, and the reason
  // 0013 exists at all.
  it('cannot be reclassified when it is a root with no children', async () => {
    // No parent and no children, so the self FK has nothing to check.
    await fixture.ledger.createAccounts(tenant.id, [
      { code: '1900', name: 'Deposit paid', type: 'asset' },
    ])
    await fixture.ledger.postEntry({
      tenantId: tenant.id,
      idempotencyKey: 'fill-1900',
      postedAt: new Date('2026-09-05T00:00:00Z'),
      description: 'Rental deposit',
      currency: 'EUR',
      lines: [
        { accountCode: '1900', direction: 'debit', amount: '250.0000' },
        { accountCode: '3000', direction: 'credit', amount: '250.0000' },
      ],
    })

    const attack = fixture.db.asTenant(
      tenant.id,
      (session) =>
        session.query("update ledger.accounts set type = 'expense' where code = '1900'"),
      { role: 'ledger_owner' },
    )

    await expect(attack).rejects.toBeInstanceOf(AccountTypeLockedError)
    await expect(attack).rejects.toMatchObject({ sqlState: 'LG011' })

    const deposit = (await fixture.ledger.listAccounts(tenant.id)).find((a) => a.code === '1900')
    expect(deposit?.type).toBe('asset')
    expect(deposit?.normalBalance).toBe('debit')
  })

  it('cannot be reclassified by moving its whole subtree in one statement', async () => {
    // Parent and children move together, so nothing ends up disagreeing with
    // anything and the self FK is satisfied. Only a trigger that knows the
    // account has postings can refuse this.
    const attack = fixture.db.asTenant(tenant.id, (session) =>
      session.query(
        "update ledger.accounts set type = 'expense' where code in ('1', '1000', '1100', '1200')",
      ),
    )

    await expect(attack).rejects.toBeInstanceOf(AccountTypeLockedError)

    const cash = (await fixture.ledger.listAccounts(tenant.id)).find((a) => a.code === '1000')
    expect(cash?.type).toBe('asset')
    expect(cash?.normalBalance).toBe('debit')
  })

  it('can still be renamed and deactivated', async () => {
    await fixture.db.asTenant(tenant.id, (session) =>
      session.query("update ledger.accounts set name = 'Cash at bank' where code = '1000'"),
    )
    const renamed = await fixture.ledger.setAccountActive(tenant.id, '1000', false)
    expect(renamed.name).toBe('Cash at bank')
    expect(renamed.isActive).toBe(false)
    await fixture.ledger.setAccountActive(tenant.id, '1000', true)
  })

  it('leaves an account with no postings free to be reclassified', async () => {
    await fixture.ledger.createAccounts(tenant.id, [
      { code: '6000', name: 'Provisionally an expense', type: 'expense' },
    ])

    await fixture.db.asTenant(tenant.id, (session) =>
      session.query("update ledger.accounts set type = 'liability' where code = '6000'"),
    )

    const account = (await fixture.ledger.listAccounts(tenant.id)).find((a) => a.code === '6000')
    expect(account?.type).toBe('liability')
    expect(account?.normalBalance).toBe('credit')
  })
})
