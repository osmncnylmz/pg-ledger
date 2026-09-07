/**
 * Ledger errors to HTTP.
 *
 * `src/errors.ts` names a refusal; this table decides what a refusal is worth
 * on the wire. The split matters: 4xx means the caller can fix it, 422 means
 * the request was well formed but the books would not accept it, and 5xx means
 * the deployment is wrong. `InsufficientPrivilegeError` is absent on purpose --
 * it means ledger_app was granted the wrong privileges, which is an operator's
 * problem and not something to describe to a client.
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

// 422: the request was understood and the books refused it.
const UNPROCESSABLE: readonly Mapping[] = [
  [UnbalancedEntryError, 422, 'unbalanced_entry', 'debits and credits do not agree'],
  [ClosedPeriodError, 422, 'closed_period', 'that accounting period is closed'],
  [NoOpenPeriodError, 422, 'no_open_period', 'no open period covers that date'],
  [MixedCurrencyError, 422, 'mixed_currency', 'a line may not leave the entry currency'],
  [NonPositiveAmountError, 422, 'non_positive_amount', 'an amount must be above zero'],
  [RollupAccountError, 422, 'rollup_account', 'only leaf accounts can be posted to'],
  [InactiveAccountError, 422, 'inactive_account', 'that account is inactive'],
  [AccountNotFoundError, 422, 'account_not_found', 'no such account in this tenant'],
  [AccountCycleError, 422, 'account_cycle', 'that would make the chart a cycle'],
]

// 409: the request quarrels with something already posted.
const CONFLICT: readonly Mapping[] = [
  [AccountTypeLockedError, 409, 'account_type_locked', 'a posted-to account keeps its type'],
  [DuplicateIdempotencyKeyError, 409, 'duplicate_idempotency_key', 'that key is taken'],
  [AlreadyReversedError, 409, 'already_reversed', 'that entry is already reversed'],
  [ImmutableJournalError, 409, 'immutable_journal', 'posted rows are append-only'],
  [OverlappingPeriodError, 409, 'overlapping_period', 'periods may not overlap'],
]

const ELSEWHERE: readonly Mapping[] = [
  [InvalidPayloadError, 400, 'invalid_payload', 'the posting payload was misshapen'],
  [EntryNotFoundError, 404, 'entry_not_found', 'no such entry in this tenant'],
  [PeriodNotFoundError, 404, 'period_not_found', 'no such period in this tenant'],
  [TenantMismatchError, 403, 'tenant_mismatch', 'that request names another tenant'],
  [TenantIsolationError, 403, 'tenant_isolation', 'that row belongs to another tenant'],
  [CrossTenantReferenceError, 403, 'cross_tenant_reference', 'that row is not this tenant'],
]

const BY_CONSTRUCTOR = new Map<unknown, Mapping>(
  [...UNPROCESSABLE, ...CONFLICT, ...ELSEWHERE].map((mapping) => [mapping[0], mapping]),
)

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
    // is answered with the message above rather than forwarded.
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
