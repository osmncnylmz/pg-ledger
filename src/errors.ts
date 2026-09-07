/**
 * Typed errors.
 *
 * Enforcement lives in the database, so every rule violation arrives here as a
 * PostgreSQL error. Leaking those to callers would tie application code to
 * driver internals and SQLSTATE trivia, so each one gets a named class.
 * Naming the refusal is all this module does; it never decides whether
 * something is allowed.
 *
 * The schema raises its own rules in SQLSTATE class `LG`, which PostgreSQL
 * reserves for user-defined conditions. Structural rules -- checks, foreign
 * keys, unique and exclusion constraints -- arrive with standard SQLSTATEs and
 * are recognised by constraint name instead.
 */

/** Shape of the error object produced by the PostgreSQL wire protocol. */
export interface PostgresErrorFields {
  readonly code?: string
  readonly detail?: string
  readonly hint?: string
  readonly constraint?: string
  readonly table?: string
  readonly column?: string
  readonly schema?: string
}

export function isPostgresError(error: unknown): error is Error & PostgresErrorFields {
  if (!(error instanceof Error)) return false
  const code: unknown = (error as unknown as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
}

/** Base class for every rule the database refused to break. */
export class LedgerError extends Error {
  readonly sqlState: string | undefined
  readonly detail: string | undefined
  readonly hint: string | undefined
  readonly constraint: string | undefined

  constructor(message: string, fields: PostgresErrorFields = {}, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.sqlState = fields.code
    this.detail = fields.detail
    this.hint = fields.hint
    this.constraint = fields.constraint
  }
}

/** SUM(debits) <> SUM(credits), or an entry with no lines at all. */
export class UnbalancedEntryError extends LedgerError {}
/** UPDATE, DELETE or TRUNCATE was attempted on a posted journal row. */
export class ImmutableJournalError extends LedgerError {}
/** The entry's date lands in a period somebody has closed. */
export class ClosedPeriodError extends LedgerError {}
/** The tenant requires periods and posted_at falls outside every one of them. */
export class NoOpenPeriodError extends LedgerError {}
/** Two periods of one tenant would overlap. */
export class OverlappingPeriodError extends LedgerError {}
/** A function was called for a tenant other than the session's tenant. */
export class TenantMismatchError extends LedgerError {}
/** A row would have referenced another tenant's row. */
export class CrossTenantReferenceError extends LedgerError {}
/** A policy refused the read or write. */
export class TenantIsolationError extends LedgerError {}
/** The role lacks the privilege for the operation. */
export class InsufficientPrivilegeError extends LedgerError {}
/** A line's currency differs from its entry's currency. */
export class MixedCurrencyError extends LedgerError {}
/** amount <= 0. Sign belongs to `direction`, never to the number. */
export class NonPositiveAmountError extends LedgerError {}
/** A posting targeted an account that has children. */
export class RollupAccountError extends LedgerError {}
/** No account with that code exists in the tenant's chart of accounts. */
export class AccountNotFoundError extends LedgerError {}
/** The account exists but is marked inactive. */
export class InactiveAccountError extends LedgerError {}
/** The chart of accounts would contain a cycle. */
export class AccountCycleError extends LedgerError {}
/** The account has postings, so its type -- and its normal balance -- is fixed. */
export class AccountTypeLockedError extends LedgerError {}
/** No accounting period with that name exists in this tenant. */
export class PeriodNotFoundError extends LedgerError {}
/** No such entry in this tenant. */
export class EntryNotFoundError extends LedgerError {}
/** The entry already has a reversal; an entry may be reversed only once. */
export class AlreadyReversedError extends LedgerError {}
/** The same idempotency key was used for a different entry. */
export class DuplicateIdempotencyKeyError extends LedgerError {}
/** The request payload was not shaped the way the SQL API expects. */
export class InvalidPayloadError extends LedgerError {}

type LedgerErrorConstructor = new (
  message: string,
  fields: PostgresErrorFields,
  options?: ErrorOptions,
) => LedgerError

/** Rules the schema raises itself, keyed by SQLSTATE. */
const BY_SQLSTATE: Readonly<Record<string, LedgerErrorConstructor>> = {
  LG001: UnbalancedEntryError,
  LG002: ImmutableJournalError,
  LG003: ClosedPeriodError,
  LG004: PeriodNotFoundError,
  LG005: TenantMismatchError,
  LG006: NoOpenPeriodError,
  LG007: RollupAccountError,
  LG008: EntryNotFoundError,
  LG009: AlreadyReversedError,
  LG010: AccountCycleError,
  LG011: AccountTypeLockedError,
  LG012: AccountNotFoundError,
  LG013: InactiveAccountError,
  LG014: InvalidPayloadError,
}

/** Structural rules, keyed by the constraint that refused the row. */
const BY_CONSTRAINT: Readonly<Record<string, LedgerErrorConstructor>> = {
  journal_lines_amount_positive: NonPositiveAmountError,
  journal_lines_currency_matches_entry: MixedCurrencyError,
  journal_lines_account_fkey: CrossTenantReferenceError,
  journal_lines_entry_fkey: CrossTenantReferenceError,
  accounts_parent_same_tenant_and_type: CrossTenantReferenceError,
  journal_entries_reverses_same_tenant: CrossTenantReferenceError,
  journal_entries_idempotency_key_key: DuplicateIdempotencyKeyError,
  journal_entries_one_reversal_key: AlreadyReversedError,
  accounting_periods_no_overlap: OverlappingPeriodError,
}

/**
 * Translate a driver error into a ledger error.
 *
 * Anything unrecognised is returned untouched: inventing a friendly name for
 * an error nobody anticipated is how real causes get hidden.
 */
export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof LedgerError) return error
  if (!isPostgresError(error)) return error

  const fields: PostgresErrorFields = {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
    ...(error.table === undefined ? {} : { table: error.table }),
  }

  const bySqlState = error.code === undefined ? undefined : BY_SQLSTATE[error.code]
  if (bySqlState) return new bySqlState(error.message, fields, { cause: error })

  const byConstraint =
    error.constraint === undefined ? undefined : BY_CONSTRAINT[error.constraint]
  if (byConstraint) return new byConstraint(error.message, fields, { cause: error })

  // Both a missing privilege and a policy refusal are SQLSTATE 42501; only the
  // message distinguishes them.
  if (error.code === '42501') {
    const Ctor = /row-level security/i.test(error.message)
      ? TenantIsolationError
      : InsufficientPrivilegeError
    return new Ctor(error.message, fields, { cause: error })
  }

  return error
}
