/**
 * Ledger errors to HTTP.
 *
 * `src/errors.ts` names a refusal; this table decides what a refusal is worth
 * on the wire. 4xx means the caller can fix it, 422 that the request was well
 * formed but the books would not accept it, 5xx that the deployment is wrong.
 *
 * `InsufficientPrivilegeError` is absent on purpose. A caller can do nothing
 * about ledger_app holding the wrong grants, and should not be handed the
 * details of one, so it falls through to the bare 500 below.
 */

import {
  AccountCycleError,
  AccountNotFoundError,
  AccountTypeLockedError,
  AlreadyReversedError,
  ClosedPeriodError,
  CrossTenantReferenceError,
  DuplicateIdempotencyKeyError,
  EntryNotFoundError,
  ImmutableJournalError,
  InactiveAccountError,
  InvalidPayloadError,
  LedgerError,
  MixedCurrencyError,
  NoOpenPeriodError,
  NonPositiveAmountError,
  OverlappingPeriodError,
  PeriodNotFoundError,
  RollupAccountError,
  TenantIsolationError,
  TenantMismatchError,
  UnbalancedEntryError,
} from '../errors.js'
import { RequestValidationError } from './validation.js'
import type { Issue } from './validation.js'

export interface ErrorBody {
  error: {
    code: string
    message: string
    detail?: string
    issues?: readonly Issue[]
  }
  requestId: string
}

/** A refusal decided by the HTTP layer rather than by the database. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** A class, the status it deserves, the wire code, and a message of last resort. */
type Mapping = readonly [new (...args: never[]) => LedgerError, number, string, string]

const MAPPINGS: readonly Mapping[] = [
  // 422: understood, and the books refused it.
  [UnbalancedEntryError, 422, 'unbalanced_entry', 'debits and credits do not agree'],
  [ClosedPeriodError, 422, 'closed_period', 'the period covering that date is closed'],
  [NoOpenPeriodError, 422, 'no_open_period', 'no open period covers that date'],
  [MixedCurrencyError, 422, 'mixed_currency', "a line's currency must be the entry's currency"],
  [NonPositiveAmountError, 422, 'non_positive_amount', 'amounts must be above zero; direction carries the sign'],
  [RollupAccountError, 422, 'rollup_account', 'that account has children, so it is a rollup and cannot be posted to'],
  [InactiveAccountError, 422, 'inactive_account', 'account is inactive'],
  [AccountNotFoundError, 422, 'account_not_found', 'no such account in this chart'],
  [AccountCycleError, 422, 'account_cycle', 'the parent link would close a loop'],

  // 409: quarrels with something already posted.
  [AccountTypeLockedError, 409, 'account_type_locked', 'an account with postings keeps its type'],
  [DuplicateIdempotencyKeyError, 409, 'duplicate_idempotency_key', 'idempotency key already in use'],
  [AlreadyReversedError, 409, 'already_reversed', 'the entry already has a reversal'],
  [ImmutableJournalError, 409, 'immutable_journal', 'posted rows are append-only'],
  [OverlappingPeriodError, 409, 'overlapping_period', 'periods may not overlap'],

  [InvalidPayloadError, 400, 'invalid_payload', 'lines must be a JSON array'],
  [EntryNotFoundError, 404, 'entry_not_found', 'no such entry'],
  [PeriodNotFoundError, 404, 'period_not_found', 'no such period'],
  [TenantMismatchError, 403, 'tenant_mismatch', 'the session is scoped to a different tenant'],
  [TenantIsolationError, 403, 'tenant_isolation', 'row belongs to another tenant'],
  [CrossTenantReferenceError, 403, 'cross_tenant_reference', 'that reference points outside this tenant'],
]

const BY_CONSTRUCTOR = new Map<unknown, Mapping>(MAPPINGS.map((m) => [m[0], m]))

export interface Described {
  status: number
  code: string
  message: string
  detail: string | undefined
  issues: readonly Issue[] | undefined
}

const INTERNAL: Described = {
  status: 500,
  code: 'internal_error',
  message: 'the request could not be completed',
  detail: undefined,
  issues: undefined,
}

function hasNumericStatus(error: unknown): error is { statusCode: number; message: string } {
  return (
    error instanceof Error &&
    typeof (error as unknown as { statusCode?: unknown }).statusCode === 'number'
  )
}

export function describeError(error: unknown): Described {
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      code: 'invalid_request',
      message: 'the request is not valid',
      detail: undefined,
      issues: error.issues,
    }
  }

  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      detail: undefined,
      issues: undefined,
    }
  }

  if (error instanceof LedgerError) {
    const mapping = BY_CONSTRUCTOR.get(error.constructor)
    if (mapping === undefined) return INTERNAL

    const [, status, code, fallback] = mapping

    // Messages raised in SQLSTATE class LG are written by this project's own
    // migrations and say something a caller can act on -- which entry, which
    // account, by how much. Everything else arrived from PostgreSQL itself and
    // is answered with the message above, not forwarded.
    const ours = error.sqlState?.startsWith('LG') === true
    return {
      status,
      code,
      message: ours ? error.message : fallback,
      detail: ours ? error.detail : undefined,
      issues: undefined,
    }
  }

  // Fastify's own client errors: an unparseable body, an unsupported content
  // type, a payload over the limit.
  if (hasNumericStatus(error) && error.statusCode >= 400 && error.statusCode < 500) {
    return {
      status: error.statusCode,
      code: 'malformed_request',
      message: error.message,
      detail: undefined,
      issues: undefined,
    }
  }

  return INTERNAL
}

export function errorBody(described: Described, requestId: string): ErrorBody {
  return {
    error: {
      code: described.code,
      message: described.message,
      ...(described.detail === undefined ? {} : { detail: described.detail }),
      ...(described.issues === undefined ? {} : { issues: described.issues }),
    },
    requestId,
  }
}
