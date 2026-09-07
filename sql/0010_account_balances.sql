-- 0010_account_balances.sql
--
-- The incrementally maintained balance cache.
--
-- Recomputing a balance by scanning the journal is O(postings) and gets
-- slower every day the business trades. This table keeps running totals per
-- (tenant, account, currency), maintained by a trigger inside the same
-- transaction as the posting, so the cache can never be stale or partially
-- applied: if the posting commits the cache moved with it, and if the posting
-- rolls back so does the cache.
--
-- Two design notes:
--
--   * The trigger is FOR EACH STATEMENT with a transition table, not FOR EACH
--     ROW. A 200-line entry produces one grouped UPSERT instead of 200.
--
--   * ledger_app has SELECT only on this table. The trigger writes through a
--     SECURITY DEFINER function owned by ledger_owner, so the totals cannot be
--     edited by the application even accidentally. FORCE ROW LEVEL SECURITY
--     still applies to the owner, so the escalation buys write access without
--     buying cross-tenant access.
--
-- Trust in the cache comes from ledger.reconcile_balances(), which compares it
-- against a full recomputation from the journal. See 0012_reporting.sql.

create table ledger.account_balances (
  tenant_id     uuid not null,
  account_id    uuid not null,
  currency      ledger.currency_code not null,

  debit_total   numeric(24, 4) not null default 0,
  credit_total  numeric(24, 4) not null default 0,

  -- Debit-positive signed balance. Reports flip the sign for accounts whose
  -- normal balance is credit.
  balance       numeric(24, 4) not null
                  generated always as (debit_total - credit_total) stored,

  line_count    bigint not null default 0,
  updated_at    timestamptz not null default now(),

  constraint account_balances_pkey primary key (tenant_id, account_id, currency),
  constraint account_balances_account_fkey
    foreign key (tenant_id, account_id) references ledger.accounts (tenant_id, id),
  constraint account_balances_totals_nonnegative
    check (debit_total >= 0 and credit_total >= 0)
);

create function ledger.apply_lines_to_balances() returns trigger
  language plpgsql
  security definer
  set search_path = ledger, pg_catalog
as $$
begin
  insert into ledger.account_balances as ab
    (tenant_id, account_id, currency, debit_total, credit_total, line_count, updated_at)
  select l.tenant_id,
         l.account_id,
         l.currency,
         coalesce(sum(l.amount) filter (where l.direction = 'debit'), 0),
         coalesce(sum(l.amount) filter (where l.direction = 'credit'), 0),
         count(*),
         now()
    from inserted_lines l
   group by l.tenant_id, l.account_id, l.currency
  on conflict (tenant_id, account_id, currency) do update
    set debit_total  = ab.debit_total  + excluded.debit_total,
        credit_total = ab.credit_total + excluded.credit_total,
        line_count   = ab.line_count   + excluded.line_count,
        updated_at   = excluded.updated_at;

  return null;
end
$$;

create trigger journal_lines_maintain_balances
  after insert on ledger.journal_lines
  referencing new table as inserted_lines
  for each statement execute function ledger.apply_lines_to_balances();

-- Administrative repair path. Dropping and rebuilding the cache is safe at any
-- time because the journal is the only source of truth; the cache is derived
-- data that happens to be materialised. Also used by the tests to prove the
-- incremental path agrees with a from-scratch build.
create function ledger.rebuild_balances(p_tenant_id uuid) returns bigint
  language plpgsql
  security definer
  set search_path = ledger, pg_catalog
as $$
declare
  v_rows bigint;
begin
  if p_tenant_id is distinct from ledger.current_tenant_id() then
    raise exception 'tenant mismatch: session is scoped to %, called with %',
      ledger.current_tenant_id(), p_tenant_id
      using errcode = 'LG005';
  end if;

  delete from ledger.account_balances where tenant_id = p_tenant_id;

  insert into ledger.account_balances
    (tenant_id, account_id, currency, debit_total, credit_total, line_count, updated_at)
  select l.tenant_id,
         l.account_id,
         l.currency,
         coalesce(sum(l.amount) filter (where l.direction = 'debit'), 0),
         coalesce(sum(l.amount) filter (where l.direction = 'credit'), 0),
         count(*),
         now()
    from ledger.journal_lines l
   where l.tenant_id = p_tenant_id
   group by l.tenant_id, l.account_id, l.currency;

  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

comment on function ledger.rebuild_balances(uuid) is
  'Drops and recomputes the balance cache for one tenant from the journal.';
