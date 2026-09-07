/**
 * Boundary validation.
 *
 * The line this module holds is *representation*, not accounting. It decides
 * whether a request can be turned into arguments without losing information --
 * whether a field is present, whether a string is a timestamp, whether an
 * amount survives the trip to numeric(20,4). It never decides whether an entry
 * balances, whether an account may be posted to, or whether a period is open.
 * Those are the database's, and a second opinion here would be a second
 * opinion that drifts.
 *
 * Zero amounts and entries with no lines are therefore *not* rejected here
 * even though they are always wrong: they are perfectly representable, and the
 * CHECK constraint on journal_lines and the deferred balance trigger already
 * refuse them.
 */

import type { Direction, NewLine } from '../types.js'

export interface Issue {
  path: string
  message: string
}

export class RequestValidationError extends Error {
  readonly issues: readonly Issue[]

  constructor(issues: readonly Issue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
    this.name = 'RequestValidationError'
    this.issues = issues
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENCY = /^[A-Z]{3}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/
// numeric(20,4): sixteen digits of headroom before the point, four after.
const DECIMAL = /^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,4})?$/

const MAX_LINES = 1000
const MAX_TEXT = 1000

/**
 * Collects every problem with a request instead of stopping at the first, so
 * one round trip tells the caller everything that is wrong. Accessors return a
 * placeholder after recording a failure; nothing reads those placeholders,
 * because `settle` throws before the parsed value is used.
 */
class Check {
  private readonly issues: Issue[] = []

  fail(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  settle<T>(value: T): T {
    if (this.issues.length > 0) throw new RequestValidationError(this.issues)
    return value
  }

  object(path: string, value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object')
      return {}
    }
    return value as Record<string, unknown>
  }

  /**
   * An empty array is not refused: an entry with no lines is representable and
   * the deferred balance trigger already calls it unbalanced. The cap is here
   * because a million-line request costs something to parse whatever the
   * database would eventually say about it.
   */
  array(path: string, value: unknown, max: number): unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, 'must be an array')
      return []
    }
    if (value.length > max) {
      this.fail(path, `must hold at most ${max} items, got ${value.length}`)
    }
    return value
  }

  text(path: string, value: unknown): string {
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string')
      return ''
    }
    if (value.trim() === '') {
      this.fail(path, 'must not be blank')
    } else if (value.length > MAX_TEXT) {
      this.fail(path, `must be at most ${MAX_TEXT} characters, got ${value.length}`)
    }
    return value
  }

  matching(path: string, value: unknown, pattern: RegExp, expected: string): string {
    if (typeof value !== 'string') {
      this.fail(path, `must be a string, ${expected}`)
      return ''
    }
    if (!pattern.test(value)) {
      this.fail(path, expected)
      return ''
    }
    return value
  }

  oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T
    }
    this.fail(path, `must be one of ${allowed.join(', ')}`)
    return allowed[0] as T
  }

  /**
   * The one rule worth stating out loud: a JSON number reaches this function
   * having already been through IEEE-754, so `20000.10` is no longer exactly
   * 20000.10 and no amount of care downstream brings the cent back. A
   * fractional number is refused rather than rounded; integers are safe up to
   * 2^53 and are accepted for the common case of whole units.
   */
  amount(path: string, value: unknown): string {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        this.fail(
          path,
          'must be a decimal string; a JSON number carries an amount only when it is a ' +
            'safe integer, since a fractional one has already lost precision in the parse',
        )
        return ''
      }
      return value.toString()
    }
    if (typeof value !== 'string') {
      this.fail(path, 'must be a decimal string or an integer')
      return ''
    }
    if (!DECIMAL.test(value)) {
      this.fail(
        path,
        'must be a decimal string with at most 16 digits before the point and 4 after, ' +
          'for example "20000.0000"',
      )
      return ''
    }
    return value
  }

  instant(path: string, value: unknown): string {
    const text = this.matching(
      path,
      value,
      ISO_INSTANT,
      'must be an ISO 8601 timestamp with a time zone',
    )
    if (text !== '' && Number.isNaN(Date.parse(text))) {
      this.fail(path, 'is not a real date')
      return ''
    }
    return text
  }

  uuid(path: string, value: unknown): string {
    return this.matching(path, value, UUID, 'must be a UUID')
  }

  integer(path: string, value: unknown, min: number, max: number): number {
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
      this.fail(path, 'must be an integer')
      return min
    }
    if (parsed < min || parsed > max) {
      this.fail(path, `must be between ${min} and ${max}`)
      return min
    }
    return parsed
  }
}

export function validateTenantHeader(value: unknown): string {
  const check = new Check()
  if (value === undefined) {
    check.fail('X-Tenant-Id', 'header is required; every request is scoped to one tenant')
    return check.settle('')
  }
  return check.settle(check.uuid('X-Tenant-Id', value))
}

export function validateUuid(path: string, value: unknown): string {
  const check = new Check()
  return check.settle(check.uuid(path, value))
}

export interface PostEntryBody {
  idempotencyKey: string
  postedAt: string
  description: string
  currency: string
  lines: NewLine[]
}

const DIRECTIONS: readonly Direction[] = ['debit', 'credit']

export function parsePostEntry(payload: unknown): PostEntryBody {
  const check = new Check()
  const body = check.object('body', payload)

  const idempotencyKey = check.text('idempotencyKey', body.idempotencyKey)
  const postedAt = check.instant('postedAt', body.postedAt)
  const description = check.text('description', body.description)
  const currency = check.matching(
    'currency',
    body.currency,
    CURRENCY,
    'must be an ISO 4217 code, for example "EUR"',
  )

  const lines = check.array('lines', body.lines, MAX_LINES).map((raw, index): NewLine => {
    const line = check.object(`lines.${index}`, raw)
    const memo = line.memo
    if (memo !== undefined && memo !== null && typeof memo !== 'string') {
      check.fail(`lines.${index}.memo`, 'must be a string or null')
    }
    return {
      accountCode: check.text(`lines.${index}.accountCode`, line.accountCode),
      direction: check.oneOf(`lines.${index}.direction`, line.direction, DIRECTIONS),
      amount: check.amount(`lines.${index}.amount`, line.amount),
      memo: typeof memo === 'string' ? memo : null,
    }
  })

  return check.settle({ idempotencyKey, postedAt, description, currency, lines })
}

export interface ReversalBody {
  postedAt?: string
  description?: string
  idempotencyKey?: string
}

export function parseReversal(payload: unknown): ReversalBody {
  const check = new Check()
  const body = check.object('body', payload ?? {})
  const reversal: ReversalBody = {}

  if (body.postedAt !== undefined) reversal.postedAt = check.instant('postedAt', body.postedAt)
  if (body.description !== undefined) reversal.description = check.text('description', body.description)
  if (body.idempotencyKey !== undefined) {
    reversal.idempotencyKey = check.text('idempotencyKey', body.idempotencyKey)
  }

  return check.settle(reversal)
}

export interface Cursor {
  postedAt: string
  id: string
}

export interface ListQuery {
  limit: number
  before?: Cursor
}

const MAX_PAGE = 200

export function parseListQuery(payload: unknown): ListQuery {
  const check = new Check()
  const query = check.object('query', payload ?? {})
  const list: ListQuery = {
    limit: query.limit === undefined ? 50 : check.integer('limit', query.limit, 1, MAX_PAGE),
  }

  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor)
    if (cursor === undefined) {
      check.fail('cursor', 'is not a cursor this API issued; use the nextCursor from a previous page')
    } else {
      list.before = cursor
    }
  }

  return check.settle(list)
}

export interface RangeQuery {
  from?: string
  to?: string
}

export function parseRangeQuery(payload: unknown): RangeQuery {
  const check = new Check()
  const query = check.object('query', payload ?? {})
  const range: RangeQuery = {}

  if (query.from !== undefined) range.from = check.instant('from', query.from)
  if (query.to !== undefined) range.to = check.instant('to', query.to)

  return check.settle(range)
}

export function parseAsOfQuery(payload: unknown): string | undefined {
  const check = new Check()
  const query = check.object('query', payload ?? {})
  if (query.asOf === undefined) return check.settle(undefined)
  return check.settle(check.instant('asOf', query.asOf))
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.postedAt}|${cursor.id}`, 'utf8').toString('base64url')
}

function decodeCursor(value: unknown): Cursor | undefined {
  if (typeof value !== 'string') return undefined

  const [postedAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|')
  if (postedAt === undefined || id === undefined || rest.length > 0) return undefined
  if (!ISO_INSTANT.test(postedAt) || Number.isNaN(Date.parse(postedAt))) return undefined
  if (!UUID.test(id)) return undefined

  return { postedAt, id }
}
