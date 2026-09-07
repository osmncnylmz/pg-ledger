-- 0003_accounts.sql
--
-- The chart of accounts: a per-tenant tree of accounts.
--
-- Two things worth noticing here are enforced declaratively, with no trigger:
--
--   * normal_balance is a STORED GENERATED column. It cannot drift from the
--     account type because it is not writable at all.
--
--   * accounts_parent_same_tenant_and_type is a three-column self foreign key.
--     It simultaneously guarantees that a parent account lives in the same
--     tenant *and* has the same account type. Because the default MATCH
--     SIMPLE semantics treat a row with any NULL referencing column as
--     satisfying the constraint, root accounts (parent_id IS NULL) are free.

create table ledger.accounts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references ledger.tenants (id),
  code            text not null,
  name            text not null,
  type            ledger.account_type not null,

  normal_balance  ledger.normal_balance not null
                    generated always as (
                      case
                        when type in ('asset', 'expense')
                          then 'debit'::ledger.normal_balance
                        else 'credit'::ledger.normal_balance
                      end
                    ) stored,

  parent_id       uuid,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),

  constraint accounts_tenant_code_key      unique (tenant_id, code),
  -- Targets for the composite foreign keys used elsewhere in the schema.
  constraint accounts_tenant_id_key        unique (tenant_id, id),
  constraint accounts_tenant_id_type_key   unique (tenant_id, id, type),

  constraint accounts_parent_same_tenant_and_type
    foreign key (tenant_id, parent_id, type)
    references ledger.accounts (tenant_id, id, type),

  constraint accounts_code_format    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  constraint accounts_not_own_parent check (parent_id is distinct from id)
);

create index accounts_parent_idx on ledger.accounts (tenant_id, parent_id);

-- A foreign key cannot see a cycle, so the one structural rule the tree needs
-- beyond the self FK is enforced by a constraint trigger. It runs AFTER the
-- row is in place so that a statement which points two existing rows at each
-- other is still caught.
create function ledger.assert_no_account_cycle() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_cursor uuid   := new.parent_id;
  v_seen   uuid[] := array[new.id];
  v_depth  int    := 0;
begin
  while v_cursor is not null loop
    if v_cursor = any (v_seen) then
      raise exception 'account % (%) would create a cycle in the chart of accounts',
        new.code, new.id
        using errcode = 'LG010',
              detail  = format('cycle through account %s', v_cursor);
    end if;

    v_seen  := v_seen || v_cursor;
    v_depth := v_depth + 1;

    if v_depth > 64 then
      raise exception 'chart of accounts is deeper than 64 levels at account %', new.code
        using errcode = 'LG010';
    end if;

    select parent_id into v_cursor from ledger.accounts where id = v_cursor;
  end loop;

  return null;
end
$$;

create constraint trigger accounts_no_cycle
  after insert or update of parent_id on ledger.accounts
  deferrable initially immediate
  for each row execute function ledger.assert_no_account_cycle();
