# pg-ledger

**A double-entry ledger where PostgreSQL enforces the accounting.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-336791.svg)](https://www.postgresql.org/)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-5fa04e.svg)](package.json)

Every rule that makes a set of books correct — entries balance, posted rows are
immutable, tenants are isolated, closed periods stay closed, a retried payment
posts once — lives in the database as a constraint, a trigger or a policy. Not
in a service. Not in an ORM hook. In the schema.

## Why this exists

Financial software usually enforces its accounting in application code, and
then discovers what that means. A background job written by a different team
skips the service layer. A data fix is typed straight into `psql` at 2am. A
migration backfills a column and forgets that debits have to move with credits.
An idempotency check does `SELECT` then `INSERT` and two concurrent webhook
deliveries slip between them. Every one of these is a bug the application-layer
rule cannot see, because the write never went through the application layer.

The database is the one component every writer has to pass through. So this
repository puts the rules there and then tries to break them. Each invariant
below has a test written as an *attack*: raw SQL, running as the application
role — and for the immutability tests, as the role that **owns the tables** —
trying to corrupt the books. The books win.

The result is small: 14 migrations, 7 tables (6 of them tenant-scoped, plus
the migration ledger), 13 triggers, 6 row-security policies, 88 table
constraints. The TypeScript on top is a typed client, not a rule engine — it
can be deleted and the guarantees still hold.

## The invariants

| # | Invariant | Mechanism | Where | Attacked by |
|---|-----------|-----------|-------|-------------|
| 1 | `SUM(debits) = SUM(credits)` for every entry | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on both journal tables | [`sql/0006_balanced_entries.sql`](sql/0006_balanced_entries.sql) | [`test/invariant-01-balanced-entries.test.ts`](test/invariant-01-balanced-entries.test.ts) |
| 2 | Posted entries and lines are append-only | `BEFORE UPDATE OR DELETE` triggers + a `BEFORE TRUNCATE` statement trigger, plus withheld grants | [`sql/0007_immutability.sql`](sql/0007_immutability.sql) | [`test/invariant-02-immutability.test.ts`](test/invariant-02-immutability.test.ts) |
| 3 | A tenant can neither read nor write another tenant's rows | RLS policies on `current_setting('app.tenant_id')` + `FORCE ROW LEVEL SECURITY` + composite FKs | [`sql/0090_security.sql`](sql/0090_security.sql) | [`test/invariant-03-tenant-isolation.test.ts`](test/invariant-03-tenant-isolation.test.ts) |
| 4 | Nothing posts into a closed period; periods never overlap | `BEFORE INSERT` trigger + `EXCLUDE USING gist (tenant_id WITH =, period WITH &&)` | [`sql/0008_period_guard.sql`](sql/0008_period_guard.sql), [`sql/0004_accounting_periods.sql`](sql/0004_accounting_periods.sql) | [`test/invariant-04-closed-periods.test.ts`](test/invariant-04-closed-periods.test.ts) |
| 5 | One idempotency key, one entry | `UNIQUE (tenant_id, idempotency_key)` driving `INSERT … ON CONFLICT DO NOTHING` | [`sql/0011_posting_api.sql`](sql/0011_posting_api.sql) | [`test/invariant-05-idempotent-posting.test.ts`](test/invariant-05-idempotent-posting.test.ts) |
| 6 | Amounts are positive; an entry has one currency | `CHECK (amount > 0)` and a composite FK `(entry_id, currency) → journal_entries (id, currency)` | [`sql/0005_journal.sql`](sql/0005_journal.sql) | [`test/money-and-currency.test.ts`](test/money-and-currency.test.ts) |
| 7 | Postings only to leaf accounts; the tree has no cycles and no type mixing | Two `AFTER` triggers, a three-column self foreign key, a cycle constraint trigger | [`sql/0003_accounts.sql`](sql/0003_accounts.sql), [`sql/0009_postable_accounts.sql`](sql/0009_postable_accounts.sql) | [`test/chart-of-accounts.test.ts`](test/chart-of-accounts.test.ts) |
| 8 | The cached balances always equal a recomputation from the journal | Statement-level trigger with a transition table + `ledger.reconcile_balances()` | [`sql/0010_account_balances.sql`](sql/0010_account_balances.sql) | [`test/balance-cache.test.ts`](test/balance-cache.test.ts), [`test/property-random-books.test.ts`](test/property-random-books.test.ts) |
| 9 | An account that has been posted to keeps its type, so posted history keeps its sign | `AFTER UPDATE OF type` trigger, backing up the self foreign key | [`sql/0013_account_type_stability.sql`](sql/0013_account_type_stability.sql) | [`test/chart-of-accounts.test.ts`](test/chart-of-accounts.test.ts) |

## Quickstart

No Docker, no local PostgreSQL, no connection string. The tests and the demo
run PostgreSQL 18 in-process through [PGlite](https://pglite.dev). From a
clone of this repository:

```bash
npm ci
npm test        # 150 tests, ~10s
npm run demo    # keeps a quarter of books, prints the reports, tries to corrupt them
npm run bench   # timings on your machine
npm run serve   # the HTTP API on 127.0.0.1:3000
```

Using it as a library:

```ts
import { Database, Ledger, UnbalancedEntryError } from 'pg-ledger'

const db = await Database.create()      // starts PostgreSQL, applies sql/*.sql
const ledger = new Ledger(db)

const tenant = await ledger.provisionTenant({
  slug: 'northwind', name: 'Northwind Consulting', baseCurrency: 'EUR',
})

await ledger.createAccounts(tenant.id, [
  { code: '1',    name: 'Assets',       type: 'asset' },
  { code: '1000', name: 'Cash at bank', type: 'asset', parentCode: '1' },
  { code: '4',    name: 'Revenue',      type: 'revenue' },
  { code: '4000', name: 'Consulting',   type: 'revenue', parentCode: '4' },
])

const { entryId, created } = await ledger.postEntry({
  tenantId: tenant.id,
  idempotencyKey: 'invoice-2026-001',   // replay-safe
  postedAt: '2026-01-20T09:00:00Z',
  description: 'Invoice 2026-001',
  currency: 'EUR',
  lines: [
    { accountCode: '1000', direction: 'debit',  amount: '20000.0000' },
    { accountCode: '4000', direction: 'credit', amount: '20000.0000' },
  ],
})

await ledger.trialBalance(tenant.id)      // always nets to zero
await ledger.statement(tenant.id, '1000') // running balance, window function
await ledger.balanceSheet(tenant.id)      // recursive CTE rollup
await ledger.reverseEntry({ tenantId: tenant.id, entryId })
```

Break something and the database says so, in a typed error:

```ts
try {
  await ledger.postEntry({ /* … debit 100.00, credit 99.99 … */ })
} catch (error) {
  error instanceof UnbalancedEntryError  // true
  error.sqlState                         // 'LG001'
  error.message
  // journal entry 3f2a… is unbalanced: debits 100.0000, credits 99.9900 (difference 0.0100)
}
```

## The HTTP API

`npm run serve` starts a Fastify server over the same `Ledger`. The routes are
transport, validation and error translation; they hold no accounting rule of
their own. The tenant comes from a header, never from the body:

```
X-Tenant-Id: 53046129-ea53-45f1-9a2b-ae140b9b1094
```

That value is set on the connection by `asTenant` for the duration of one
transaction, so a request reaching for another tenant's entry is not filtered
out by a `WHERE` clause in the route — the row is not visible to it at all. A
request with no header is refused before it reaches the database.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | Queries the schema; 503 when the database does not answer |
| `POST` | `/v1/entries` | Posts one entry. `201` with a `Location`, or `200` over the existing entry when the idempotency key is a replay |
| `GET` | `/v1/entries` | Newest first, `?limit=` and an opaque `?cursor=` |
| `GET` | `/v1/entries/:id` | One entry with its lines |
| `POST` | `/v1/entries/:id/reversal` | Posts the mirror entry |
| `GET` | `/v1/accounts` | The chart of accounts |
| `GET` | `/v1/accounts/:code/statement` | Postings with a running balance, `?from=` `?to=` |
| `GET` | `/v1/reports/trial-balance` | `?asOf=` |

There is no route that creates a tenant. Provisioning inserts into
`ledger.tenants`, which `ledger_app` has no `INSERT` on — it runs as the
administrative role, and the API never assumes it. On an empty database
`npm run serve` provisions one demo tenant and logs its id, which is where the
`$TENANT` below comes from.

```bash
curl -i -X POST http://127.0.0.1:3000/v1/entries \
  -H 'Content-Type: application/json' \
  -H "X-Tenant-Id: $TENANT" \
  -d '{
    "idempotencyKey": "invoice-2026-001",
    "postedAt": "2026-01-20T09:00:00Z",
    "description": "Invoice 2026-001",
    "currency": "EUR",
    "lines": [
      { "accountCode": "1000", "direction": "debit",  "amount": "20000.0000" },
      { "accountCode": "4000", "direction": "credit", "amount": "20000.0000" }
    ]
  }'
```

Amounts are decimal strings, or integers for whole units. A fractional JSON
number is a 400: by the time the route sees `20000.10` it is a double and the
cent has already gone, so accepting it would only hide that.

Every refusal has one shape, and the status says whose problem it is — 400 the
request, 404 the address, 409 a conflict with what is already posted, 422 an
accounting rule, 500 the deployment.

```json
{
  "error": {
    "code": "unbalanced_entry",
    "message": "journal entry 3f2a… is unbalanced: debits 100.0000, credits 99.9900 (difference 0.0100)",
    "detail": "entry_id=3f2a… debits=100.0000 credits=99.9900 lines=2"
  },
  "requestId": "56a63a33-65ea-4161-89ae-e9f5177bd314"
}
```

## The most interesting code in the repository

Invariant #1 is enforced by this, and it is worth reading closely:

```sql
create function ledger.assert_entry_balanced() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_entry_id uuid;
  v_debits   numeric(20, 4);
  v_credits  numeric(20, 4);
  v_lines    bigint;
begin
  if tg_table_name = 'journal_entries' then
    v_entry_id := new.id;
  else
    v_entry_id := new.entry_id;
  end if;

  select coalesce(sum(amount) filter (where direction = 'debit'), 0),
         coalesce(sum(amount) filter (where direction = 'credit'), 0),
         count(*)
    into v_debits, v_credits, v_lines
    from ledger.journal_lines
   where entry_id = v_entry_id;

  if v_lines = 0 then
    raise exception 'journal entry % has no lines', v_entry_id
      using errcode = 'LG001',
            detail  = format('entry_id=%s debits=0 credits=0 lines=0', v_entry_id),
            hint    = 'An entry must contain at least one debit and one credit line.';
  end if;

  if v_debits <> v_credits then
    raise exception 'journal entry % is unbalanced: debits %, credits % (difference %)',
      v_entry_id, v_debits, v_credits, v_debits - v_credits
      using errcode = 'LG001',
            detail  = format('entry_id=%s debits=%s credits=%s lines=%s',
                             v_entry_id, v_debits, v_credits, v_lines),
            hint    = 'Every entry must satisfy SUM(debits) = SUM(credits).';
  end if;

  return null;
end
$$;

create constraint trigger journal_entries_balanced
  after insert on ledger.journal_entries
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();

create constraint trigger journal_lines_keep_entry_balanced
  after insert on ledger.journal_lines
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();
```

### Why a plain row-level trigger cannot do this

A `BEFORE`/`AFTER … FOR EACH ROW` trigger fires while the statement is
running. At the moment the first line of a two-line entry is inserted, the
entry is by construction unbalanced: there is one line and it is a debit. A
normal trigger would reject **every entry ever written**.

You could work around that by demanding that all lines arrive in one
`INSERT … VALUES (…), (…)`. But that is a rule the database cannot enforce —
nothing stops a second statement, or a second transaction, from appending one
more line to a balanced entry afterwards — and it makes the rule a convention
again, which is the thing this project is trying to avoid.

`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` fires at `COMMIT`, after
every statement in the transaction has run. Lines may be inserted one at a
time, in any order, by any number of statements. The books are allowed to be
transiently unbalanced *inside* a transaction and are never allowed to be
unbalanced *between* transactions — which is exactly the accounting rule, and
exactly what [the first test](test/invariant-01-balanced-entries.test.ts)
demonstrates by inserting one line, reading the books back mid-transaction to
show they do not balance, and then inserting the second.

Two triggers are installed because there are two ways to break balance: an
entry created with no lines or with lines that do not add up (caught on
`journal_entries`), and a line appended later to an entry that was already
balanced and committed (caught on `journal_lines`). The second case is the one
a single trigger on the entry table would silently miss.

### Why not enforce this in the application layer?

Three reasons, in increasing order of how much they cost when you are wrong.

**Coverage.** An application-layer rule protects the writes that go through the
application. Reporting jobs, data fixes, migrations, admin scripts, the other
team's Python worker and a human with `psql` do not. A constraint covers every
writer, forever, including the ones that do not exist yet.

**Atomicity.** "Check, then write" is two operations, and concurrency lives in
the gap between them. Two webhook deliveries for the same payment both `SELECT`
and find nothing, and both `INSERT`. A unique index does not have that gap: the
second writer blocks on the index tuple and then loses. The same argument
applies to non-overlapping accounting periods, which is why they are an
`EXCLUDE` constraint rather than a "does one overlap?" query.

**Provability.** An application check is true of the code path you read. A
constraint is true of the data. `SELECT … FROM journal_lines GROUP BY entry_id
HAVING sum(...) <> 0` cannot return a row — not "should not", *cannot*.

The trade-off is real and worth stating: errors arrive as `SQLSTATE`s rather
than as validation objects, some rules only surface at `COMMIT`, and the logic
is written in SQL, which is harder to unit test in isolation and harder to
reuse across databases. This repository accepts all three. The mapping layer in
[`src/errors.ts`](src/errors.ts) pays down the first, and the test suite pays
down the second and third by testing the rules where they actually live.

## Architecture

```
sql/                    the schema, as ordered migrations — this is the product
  0001_foundation       extensions, schema, roles, enums, the currency domain
  0002_tenants
  0003_accounts         generated normal_balance, 3-column self FK, cycle guard
  0004_accounting_periods   tstzrange + GiST exclusion constraint
  0005_journal          entries and lines; the composite FK that pins currency
  0006_balanced_entries deferred constraint triggers          <- invariant 1
  0007_immutability     append-only triggers, incl. TRUNCATE  <- invariant 2
  0008_period_guard     closed-period trigger                 <- invariant 4
  0009_postable_accounts  postings only to leaf accounts
  0010_account_balances the cache + statement-level trigger   <- invariant 8
  0011_posting_api      post_entry (idempotent), reverse_entry <- invariant 5
  0012_reporting        trial balance, statement, rollups, reconciliation
  0013_account_type_stability  posted-to accounts keep their type <- invariant 9
  0090_security         RLS policies, FORCE RLS, ownership, grants <- invariant 3

src/
  migrations.ts   loads sql/*.sql, hashes each file
  database.ts     PGlite handle; asTenant() opens a transaction, sets
                  app.tenant_id and drops to the ledger_app role
  ledger.ts       the typed API — shapes arguments, maps rows, no rules
  errors.ts       SQLSTATE and constraint name -> typed error
  types.ts        domain types; money is `string`, never `number`
  api/
    server.ts     Fastify; the tenant header, the error handler, /health
    routes.ts     one call into Ledger per route
    validation.ts request shape and money precision at the boundary
    errors.ts     typed ledger error -> HTTP status and error body
  scripts/        demo.ts, bench.ts, serve.ts

test/             one file per invariant, each written as an attack
                  plus api.test.ts, which drives the routes through inject
```

There are two database roles. `ledger_owner` owns every object and is never
used by the application. `ledger_app` is what the application connects as: no
`DELETE` anywhere, no `UPDATE` on the journal, `SELECT` only on the balance
cache. Both are `NOLOGIN`; a deployment creates a login role and grants
`ledger_app` to it.

There is exactly one way to touch tenant data:

```ts
await db.asTenant(tenantId, async (session) => { /* … */ })
// begin
//   set local search_path to ledger, public
//   select set_config('app.tenant_id', $1, true)
//   set local role ledger_app
//   …
// commit   <- the deferred balance check fires here
```

Both settings are `LOCAL`, so a connection cannot leak one request's tenant
into the next, and error mapping wraps the whole transaction rather than
individual statements — because the most important error arrives at `COMMIT`.

## Engineering notes

**Mixed-currency entries are unrepresentable, not rejected.** Each entry
declares a currency; each line's currency is tied to it by a composite foreign
key to `(journal_entries.id, currency)`. There is no trigger to forget and no
window between reading the entry and inserting the line.

**A three-column self foreign key does two jobs.** `accounts (tenant_id,
parent_id, type) → accounts (tenant_id, id, type)` says, in one constraint,
that a parent lives in the same tenant *and* has the same account type. Root
accounts are free because `MATCH SIMPLE` treats a row with a NULL referencing
column as satisfied.

**`normal_balance` is a generated column.** `asset`/`expense` are debit-normal,
everything else is credit-normal; the column is `GENERATED ALWAYS … STORED`, so
it cannot drift from the type it is derived from — writing it raises `428C9`.

**Deriving `normal_balance` from `type` moves the problem to `type`.** An
append-only journal is not enough on its own: change an account from `asset`
to `expense` and every figure that account has ever contributed changes sign
and moves from the balance sheet to the income statement, without one journal
row being touched. The three-column self FK catches the obvious attempt — a
child whose type stops matching its parent's — but not an account that is its
own root, and not a parent and its children updated in the same statement,
where every row still agrees with every other row. `sql/0013` closes both:
once an account has journal lines its `type` is fixed. Renaming, reparenting
within the same type and deactivating stay available, which is what
`ledger_app` actually needs `UPDATE` on `accounts` for.

**`FORCE ROW LEVEL SECURITY` is the load-bearing word.** Without it, the table
owner bypasses every policy — and migrations, maintenance jobs and
`SECURITY DEFINER` functions all run as the owner, so the exemption would cover
exactly the code paths that touch the most rows. The isolation test
[asserts the flag is set on all six tables](test/invariant-03-tenant-isolation.test.ts)
and runs its read attack as the owner.

**Policies fail closed.** `ledger.current_tenant_id()` returns `NULL` when
`app.tenant_id` is unset, every policy predicate evaluates to `NULL`, and a
session that forgot to identify itself sees zero rows and writes none. The
failure mode of a forgotten `SET` is an empty result, never someone else's
books.

**RLS does not stop cross-tenant *references*.** PostgreSQL runs referential
integrity checks with row security bypassed, so a policy alone would happily
let a line point at another tenant's account. The composite FK
`(tenant_id, account_id)` is what closes that, and there is a test for it.

**The balance cache escalates privileges without escaping isolation.** The
cache is maintained by an `AFTER INSERT … REFERENCING NEW TABLE … FOR EACH
STATEMENT` trigger, so a 200-line entry is one grouped `UPSERT` rather than 200.
It writes through a `SECURITY DEFINER` function owned by `ledger_owner`, which
is why `ledger_app` can hold `SELECT`-only on the table — and because `FORCE
ROW LEVEL SECURITY` applies to the owner too, the escalation buys write access
without buying cross-tenant access.

**The reconciliation is the showpiece.** `ledger.reconcile_balances(tenant)`
full-outer-joins the incrementally maintained cache against a from-scratch
recomputation and returns the disagreements. The tests assert it is empty after
300 random entries — and, because "always returns empty" would pass that
assertion just as well, they also corrupt a cached row by `0.01` and assert the
function *finds* it, then repair it with `ledger.rebuild_balances()` and assert
it is empty again.

**Correction is a reversal, and the link lives on the new row.** Pointing the
original at its reversal would require an `UPDATE` of a posted entry, which is
precisely what invariant #2 forbids. So the reversing entry carries
`reverses_entry_id`, a `UNIQUE (tenant_id, reverses_entry_id)` makes double
reversal impossible, and the reverse direction is read through a
`security_invoker` view.

**A statement's running balance opens correctly.** `WHERE` is applied before
window functions, so filtering by a start date in the same `SELECT` as the
window would hide earlier rows from the frame and restart the balance at zero.
The frame is computed in its own CTE and the date filter applied outside it —
so a statement for February opens at January's closing balance. This was a real
bug, caught by a test that asserted the opening figure.

## Performance

One thing the benchmark found, and one thing it ruled out. Both were measured
the same way: run the suite against the schema as it stands, then again
against a copy of `sql/` with the one line in question reverted, on the same
data set. Anyone can repeat it; nothing below is a remembered number.

**A missing index column turned a join into a nested rescan.** RLS silently
adds `tenant_id = current_tenant_id()` to every read of `journal_lines`. With
the index on `(entry_id)` alone, the planner combines it with the account
index in a `BitmapAnd` that rescans the account index once per entry. Making
the index `(entry_id, tenant_id)` — leading with `entry_id` so the balance
trigger's single-column lookup still works — is the difference between these
two columns, over a journal of 2 001 entries / 4 200 lines, three runs each:

| | `(entry_id)` | `(entry_id, tenant_id)` |
|---|---|---|
| trial balance, mean of 10 | 68 – 92 ms | 4.0 – 4.5 ms |
| one 200-line posting | 87 – 124 ms | 20 – 21 ms |

**Hoisting a constant out of the row loop is worth less than it looks.**
`account_statement` reads the account's normal balance once into a variable
rather than looking it up per line, and the comment in
[`sql/0012_reporting.sql`](sql/0012_reporting.sql) used to claim a large win
for that. Measured, it does not hold. For a 2 000-row statement:

| shape of the per-row lookup | mean of 10 |
|---|---|
| read once into a variable (what the code does) | 18 ms |
| `join ledger.accounts` on every line | 19 ms |
| correlated scalar subquery on every line | 32 ms |
| PL/pgSQL lookup function called on every line | 52 ms |

So the join form costs nothing the planner does not already remove, and the
variable is kept for clarity rather than for speed. What genuinely does cost
is a subquery or a function call evaluated per row — which is the general
lesson, and the reason the comment now says that instead.

Measured on this machine — Apple Silicon (darwin/arm64), Node v25.9.0, PGlite
0.5.8, journal of 2 001 entries / 4 200 lines. Reproduce the summary below
with `npm run bench`; expect your own numbers to differ:

```
schema bootstrap (initdb + 14 migrations)  871.2 ms
PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten

posting 2000 two-line entries, one transaction each
postEntry (2 lines, own transaction)       mean    0.9 ms   p50    0.8 ms   p95    1.3 ms
throughput                                 1134 entries/s, 2268 lines/s

posting one 200-line entry (statement-level cache trigger)
postEntry (200 lines)                      22.3 ms

journal now holds 2001 entries / 4200 lines

trialBalance (full scan of the journal)    mean    4.1 ms   p50    3.9 ms   p95    6.4 ms
currentBalances (cache read)               mean    0.6 ms   p50    0.5 ms   p95    1.4 ms
reconcileBalances (cache vs recompute)     mean    1.9 ms   p50    1.8 ms   p95    2.8 ms
balanceSheet (recursive CTE rollup)        mean    3.4 ms   p50    3.3 ms   p95    5.6 ms
statement of 1000 (window function)        mean   17.2 ms   p50   17.1 ms   p95   20.2 ms

reconciliation drift: 0 rows (0 means the cache is exact)
```

These are PGlite numbers: PostgreSQL 18 compiled to WebAssembly, in-process,
one connection, no network round trip and no concurrency. They are useful for
comparing shapes of queries against each other, which is what they were used
for above. They are **not** a throughput figure for a real server — a native
build with a connection pool will differ in both directions.

## Errors

Database exceptions are translated into named errors by
[`src/errors.ts`](src/errors.ts), which does nothing else — it never decides
whether something is allowed, only what to call the refusal. Anything
unrecognised is rethrown untouched.

| Error | Raised by |
|---|---|
| `UnbalancedEntryError` | `LG001` — the deferred balance trigger, at `COMMIT` |
| `ImmutableJournalError` | `LG002` — `UPDATE`/`DELETE`/`TRUNCATE` on the journal |
| `ClosedPeriodError` / `NoOpenPeriodError` | `LG003` / `LG006` — the period guard |
| `TenantMismatchError` | `LG005` — a report asked for another tenant |
| `RollupAccountError` | `LG007` — a posting to an account with children |
| `EntryNotFoundError` / `AlreadyReversedError` | `LG008` / `LG009` — `reverse_entry` |
| `AccountCycleError` | `LG010` — the chart-of-accounts cycle guard |
| `AccountTypeLockedError` | `LG011` — reclassifying an account that has postings |
| `AccountNotFoundError` / `InactiveAccountError` | `LG012` / `LG013` — account resolution |
| `PeriodNotFoundError` | `LG004` — no period of that name in this tenant |
| `InvalidPayloadError` | `LG014` — `post_entry` was handed something that is not a JSON array |
| `MixedCurrencyError` | `23503` on `journal_lines_currency_matches_entry` |
| `NonPositiveAmountError` | `23514` on `journal_lines_amount_positive` |
| `CrossTenantReferenceError` | `23503` on a composite tenant foreign key |
| `DuplicateIdempotencyKeyError` | `23505` on the idempotency key |
| `OverlappingPeriodError` | `23P01` on the period exclusion constraint |
| `TenantIsolationError` / `InsufficientPrivilegeError` | `42501`, split on the message |

Custom rules use `SQLSTATE` class `LG`, which PostgreSQL reserves for
user-defined conditions.

Two of these are raised by the TypeScript layer rather than by the schema:
`AccountNotFoundError` when a `parentCode` or an account code handed to
`createAccounts`/`setAccountActive` matches nothing, and `PeriodNotFoundError`
when `setPeriodState` names a period that does not exist. Those are argument
resolution, not accounting — the schema cannot refuse them, because the row
they would produce is perfectly legal. They carry the same `sqlState` as the
equivalent database refusal so a caller can branch on one thing.

Over HTTP the same list is read once more, by
[`src/api/errors.ts`](src/api/errors.ts), which decides what each refusal is
worth as a status code. `InsufficientPrivilegeError` is deliberately missing
from that table: it means `ledger_app` was granted the wrong privileges, which
is an operator's problem and becomes a 500.

## Tests

150 tests over 13 files, about 10 seconds. Every test file starts its own
PostgreSQL and applies the real migrations — no mocks, no fakes, no in-memory
substitute for the thing being tested. The API tests are the same: they drive
the real routes through Fastify's `inject`, against a real ledger, so the 422s
they assert on are the database refusing rather than a stub.

The invariant tests deliberately **bypass the TypeScript layer**. They open a
session and write raw SQL as `ledger_app`, or as `ledger_owner` where the point
is that ownership does not help. If any of them passed, the TypeScript checks
would be the only thing between a bug and corrupt books — which is the
situation this project exists to avoid.

[`test/property-random-books.test.ts`](test/property-random-books.test.ts)
generates 300 random balanced entries — random dates, accounts, line counts,
amounts and three currencies — reverses roughly one in ten, and then asserts
that the trial balance nets to exactly zero per currency, the accounting
equation holds per currency, the cache reconciles with the journal, an
incremental cache equals a rebuilt one, every account statement's final running
balance matches the cache, and every parent's rollup equals the sum of its
leaves. The generator is seeded, so a failure is reproducible.

```bash
npm test                                    # everything
npm run test:api                            # the HTTP layer alone
npx vitest run test/invariant-03-tenant-isolation.test.ts
npx vitest                                  # watch mode
```

## Running against a real PostgreSQL

The schema is ordinary PostgreSQL 18 — `btree_gist` is the only extension.
[`docker-compose.yml`](docker-compose.yml) starts a server and applies `sql/*.sql`
through the official image's init hook, in the same order and as the same
superuser the migration runner uses:

```bash
docker compose up -d
docker compose exec db psql -U postgres -d ledger -c '\dt ledger.*'
docker compose exec db psql -U postgres -d ledger \
  -c "create role app login password 'app'; grant ledger_app to app;"
```

Two honest caveats. The test suite does not use this file — it runs against
PGlite, which is why CI declares no services and needs no wait-for-postgres
step. And the shipped client is the PGlite one: `Database` in
[`src/database.ts`](src/database.ts) is where a `node-postgres` driver would
slot in, and it is not written here, because a driver that has never been run
is not something to claim as a feature.

## Limitations

* **Single-node.** No sharding, no partitioning of the journal, no archival of
  closed periods. The indexes are the ones this workload needs, not the ones a
  billion-row journal would.
* **No FX.** Multi-currency here means balances are tracked per currency and an
  entry cannot mix them. There is no revaluation, no rate table, no gain/loss
  posting.
* **No period-close postings.** Closing a period sets a flag; it does not roll
  revenue and expenses into retained earnings. `accounting_equation()` reports
  net income as a separate term for that reason.
* **No authentication.** The API reads the tenant from `X-Tenant-Id` and
  believes it. In a deployment that header is written by whatever terminates
  authentication and is stripped from anything a client sends. Row level
  security limits the damage of getting that wrong to one tenant's books, but
  it is not a substitute for the check.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Osman Can YILMAZ.
