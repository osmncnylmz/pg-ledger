/**
 * Error translation. Enforcement stays in SQL; this layer only gives the
 * refusal a name a caller can branch on.
 */

import { describe, expect, it } from 'vitest'

import {
  ClosedPeriodError,
  LedgerError,
  MixedCurrencyError,
  TenantIsolationError,
  UnbalancedEntryError,
  isPostgresError,
  mapDatabaseError,
} from '../src/errors.js'

function pgError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields.message ?? 'boom'), fields)
}

describe('mapDatabaseError', () => {
  it('maps a ledger SQLSTATE to its named error and keeps the diagnostics', () => {
    const mapped = mapDatabaseError(
      pgError({
        message: 'journal entry 42 is unbalanced: debits 10, credits 9 (difference 1)',
        code: 'LG001',
        detail: 'entry_id=42 debits=10 credits=9 lines=2',
        hint: 'Every entry must satisfy SUM(debits) = SUM(credits).',
      }),
    )

    expect(mapped).toBeInstanceOf(UnbalancedEntryError)
    expect(mapped).toBeInstanceOf(LedgerError)
    const error = mapped as UnbalancedEntryError
    expect(error.name).toBe('UnbalancedEntryError')
    expect(error.sqlState).toBe('LG001')
    expect(error.detail).toContain('entry_id=42')
    expect(error.hint).toContain('SUM(debits)')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('maps a structural constraint by name', () => {
    const mapped = mapDatabaseError(
      pgError({
        message: 'insert or update on table "journal_lines" violates foreign key constraint',
        code: '23503',
        constraint: 'journal_lines_currency_matches_entry',
      }),
    )

    expect(mapped).toBeInstanceOf(MixedCurrencyError)
    expect((mapped as MixedCurrencyError).constraint).toBe('journal_lines_currency_matches_entry')
  })

  it('separates a policy refusal from a missing privilege, both 42501', () => {
    expect(
      mapDatabaseError(
        pgError({
          message: 'new row violates row-level security policy for table "accounts"',
          code: '42501',
        }),
      ),
    ).toBeInstanceOf(TenantIsolationError)

    expect(
      mapDatabaseError(pgError({ message: 'permission denied for table journal_entries', code: '42501' })),
    ).not.toBeInstanceOf(TenantIsolationError)
  })

  it('returns an unrecognised database error untouched', () => {
    // Inventing a friendly name for an unanticipated error is how real
    // causes get hidden.
    const original = pgError({ message: 'connection reset', code: '08006' })
    expect(mapDatabaseError(original)).toBe(original)
  })

  it('returns a non-database error untouched', () => {
    const original = new TypeError('undefined is not a function')
    expect(mapDatabaseError(original)).toBe(original)
    expect(mapDatabaseError('a string')).toBe('a string')
  })

  it('never double-wraps', () => {
    const once = mapDatabaseError(pgError({ message: 'closed', code: 'LG003' }))
    expect(once).toBeInstanceOf(ClosedPeriodError)
    expect(mapDatabaseError(once)).toBe(once)
  })

  it('recognises a driver error by its SQLSTATE shape', () => {
    expect(isPostgresError(pgError({ code: '23505' }))).toBe(true)
    expect(isPostgresError(pgError({ code: 'nope' }))).toBe(false)
    expect(isPostgresError(new Error('plain'))).toBe(false)
    expect(isPostgresError({ code: '23505' })).toBe(false)
  })
})
