-- 0090_security.sql
--
-- Invariant #3: tenant isolation.
--
-- Every tenant-scoped table gets a policy that reduces to one equality test
-- against ledger.current_tenant_id(). Two details matter more than the
-- policies themselves:
--
--   * FORCE ROW LEVEL SECURITY. Without it, the table owner silently bypasses
--     every policy. Since a migration, a maintenance script and any
--     SECURITY DEFINER function all run as the owner, "we have RLS" without
--     FORCE means "we have RLS except in exactly the code paths that touch
--     the most rows".
--
--   * Fail-closed defaults. current_tenant_id() returns NULL when app.tenant_id
--     is unset, every predicate evaluates to NULL, and a session that forgot to
--     identify itself reads zero rows and writes none. The failure mode of a
--     forgotten SET is an empty result, never another tenant's books.
--
-- Privileges are the outer layer. ledger_app holds no DELETE anywhere and no
-- UPDATE on the journal, so the immutability triggers in 0007 are a second
-- line of defence rather than the only one.

-- --------------------------------------------------------------------------
-- Policies
-- --------------------------------------------------------------------------

alter table ledger.tenants enable row level security;
alter table ledger.tenants force row level security;

create policy tenants_self_only on ledger.tenants
  for select
  using (id = ledger.current_tenant_id());

alter table ledger.accounts enable row level security;
alter table ledger.accounts force row level security;

create policy accounts_tenant_isolation on ledger.accounts
  for all
  using (tenant_id = ledger.current_tenant_id())
  with check (tenant_id = ledger.current_tenant_id());

alter table ledger.accounting_periods enable row level security;
alter table ledger.accounting_periods force row level security;

create policy accounting_periods_tenant_isolation on ledger.accounting_periods
  for all
  using (tenant_id = ledger.current_tenant_id())
  with check (tenant_id = ledger.current_tenant_id());

alter table ledger.journal_entries enable row level security;
alter table ledger.journal_entries force row level security;

create policy journal_entries_tenant_isolation on ledger.journal_entries
  for all
  using (tenant_id = ledger.current_tenant_id())
  with check (tenant_id = ledger.current_tenant_id());

alter table ledger.journal_lines enable row level security;
alter table ledger.journal_lines force row level security;

create policy journal_lines_tenant_isolation on ledger.journal_lines
  for all
  using (tenant_id = ledger.current_tenant_id())
  with check (tenant_id = ledger.current_tenant_id());

alter table ledger.account_balances enable row level security;
alter table ledger.account_balances force row level security;

create policy account_balances_tenant_isolation on ledger.account_balances
  for all
  using (tenant_id = ledger.current_tenant_id())
  with check (tenant_id = ledger.current_tenant_id());

-- --------------------------------------------------------------------------
-- Ownership
-- --------------------------------------------------------------------------
-- Migrations run as a superuser, so everything created so far is owned by
-- that superuser. Hand it all to ledger_owner, which is a plain role: it is
-- subject to FORCE ROW LEVEL SECURITY, and it is what SECURITY DEFINER
-- functions will run as.

alter schema ledger owner to ledger_owner;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as ident, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ledger'
       and c.relkind in ('r', 'p', 'v', 'm', 'S')
  loop
    case r.relkind
      when 'v' then execute format('alter view %s owner to ledger_owner', r.ident);
      when 'm' then execute format('alter materialized view %s owner to ledger_owner', r.ident);
      when 'S' then execute format('alter sequence %s owner to ledger_owner', r.ident);
      else          execute format('alter table %s owner to ledger_owner', r.ident);
    end case;
  end loop;

  for r in
    select p.oid::regprocedure as ident
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'ledger' and p.prokind = 'f'
  loop
    execute format('alter function %s owner to ledger_owner', r.ident);
  end loop;

  for r in
    select t.oid::regtype as ident
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'ledger' and t.typtype in ('e', 'd', 'c')
       and not exists (
         select 1 from pg_class c where c.oid = t.typrelid and c.relkind <> 'c'
       )
  loop
    execute format('alter type %s owner to ledger_owner', r.ident);
  end loop;
end
$$;

-- --------------------------------------------------------------------------
-- Privileges
-- --------------------------------------------------------------------------

grant usage on schema ledger to ledger_app;

grant select on ledger.tenants                to ledger_app;
grant select on ledger.account_balances       to ledger_app;
grant select on ledger.journal_entry_status   to ledger_app;

grant select, insert, update on ledger.accounts           to ledger_app;
grant select, insert, update on ledger.accounting_periods to ledger_app;

-- No UPDATE. No DELETE. Ever.
grant select, insert on ledger.journal_entries to ledger_app;
grant select, insert on ledger.journal_lines   to ledger_app;

grant execute on all functions in schema ledger to ledger_app;

-- SECURITY DEFINER functions must not be reachable by roles that were never
-- meant to have them, even if someone later grants USAGE on the schema.
revoke all on function ledger.apply_lines_to_balances() from public;
revoke all on function ledger.rebuild_balances(uuid) from public;
grant execute on function ledger.rebuild_balances(uuid) to ledger_app;
