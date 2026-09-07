-- Invariant #3: tenant isolation.
--
-- Every tenant-scoped table gets a policy that reduces to one equality test
-- against ledger.current_tenant_id(), which 0001 defines and which returns
-- NULL when nobody has said who they are.
--
-- FORCE ROW LEVEL SECURITY is the line to read twice. A table owner bypasses
-- every policy on that table unless it is set, and the code that runs as the
-- owner is not the marginal code -- it is the migrations, the maintenance
-- scripts and every SECURITY DEFINER function in this schema. Enabling RLS
-- without forcing it protects the queries that touch the fewest rows and
-- exempts the ones that touch the most.
--
-- Privileges are the outer layer. ledger_app holds no DELETE anywhere and no
-- UPDATE on the journal, so the immutability triggers in 0007 are the second
-- of two answers, not the only one.

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

-- Migrations run as a superuser, so everything created so far is owned by that
-- superuser. Hand it all to ledger_owner, which is a plain role: subject to
-- FORCE ROW LEVEL SECURITY, and what the SECURITY DEFINER functions run as.

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
