-- Extensions, schema, roles, enumerations and domains.
--
-- ledger_owner owns every object in the schema. Deployments never connect as
-- it. It exists so that the application role is a *non-owner*, and so that the
-- few operations which must escalate -- maintaining the balance cache -- can
-- do so through one narrowly scoped SECURITY DEFINER function.
--
-- ledger_app is what the application connects as: the minimum privileges it
-- needs (no DELETE anywhere, no UPDATE on the journal) and no exemption from
-- row level security.
--
-- Both are NOLOGIN. A real deployment creates a login role and GRANTs
-- ledger_app to it.

-- btree_gist lets a GiST exclusion constraint mix an equality column
-- (tenant_id) with a range column (the accounting period).
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_owner') then
    create role ledger_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ledger_app') then
    create role ledger_app nologin;
  end if;
end
$$;

create schema if not exists ledger;

grant usage on schema ledger to ledger_app, ledger_owner;

alter role ledger_owner set search_path to ledger, public;
alter role ledger_app set search_path to ledger, public;

create type ledger.account_type as enum (
  'asset', 'liability', 'equity', 'revenue', 'expense'
);

create type ledger.normal_balance as enum ('debit', 'credit');

create type ledger.entry_direction as enum ('debit', 'credit');

create type ledger.period_state as enum ('open', 'closed');

-- ISO 4217 alphabetic code. A domain, not char(3), so that the
-- constraint travels with every column that stores a currency.
create domain ledger.currency_code as text
  constraint currency_code_iso4217 check (value ~ '^[A-Z]{3}$');

-- The tenant the current session is acting for. Every row level security
-- policy is written in terms of this function, so its NULL is load-bearing:
-- when app.tenant_id is unset or empty every policy predicate evaluates to
-- NULL and the session sees and writes nothing at all. Forget the SET and you
-- get an empty result, not someone else's books.
create function ledger.current_tenant_id() returns uuid
  language sql
  stable
  set search_path = pg_catalog
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

comment on function ledger.current_tenant_id() is
  'Tenant of the current session, from the app.tenant_id GUC. NULL when unset (fail-closed).';
