-- Accounting periods, stored as a half-open timestamptz range.
--
-- accounting_periods_no_overlap is the constraint worth looking at: a GiST
-- exclusion constraint that makes overlapping periods within one tenant
-- structurally impossible. A trigger doing the same job would be racy -- two
-- concurrent transactions each look, see no overlap, and both insert. An
-- exclusion constraint takes the same index locks a unique constraint does, so
-- the second writer blocks and then fails.

create table ledger.accounting_periods (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references ledger.tenants (id),
  name        text not null,
  period      tstzrange not null,
  state       ledger.period_state not null default 'open',
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),

  constraint accounting_periods_tenant_name_key unique (tenant_id, name),
  constraint accounting_periods_tenant_id_key   unique (tenant_id, id),

  constraint accounting_periods_bounded check (
    not isempty(period) and not lower_inf(period) and not upper_inf(period)
  ),

  -- closed_at is set by a trigger. The check makes the two columns
  -- inseparable even if that trigger is ever dropped.
  constraint accounting_periods_closed_at_agrees check (
    (state = 'closed') = (closed_at is not null)
  ),

  constraint accounting_periods_no_overlap
    exclude using gist (tenant_id with =, period with &&)
);

comment on constraint accounting_periods_no_overlap on ledger.accounting_periods is
  'Two periods of one tenant can never overlap; enforced by index, not by a racy read-then-write trigger.';

create function ledger.stamp_period_state() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
begin
  if new.state = 'closed' then
    if tg_op = 'INSERT' or old.state <> 'closed' then
      new.closed_at := now();
    end if;
  else
    new.closed_at := null;
  end if;

  return new;
end
$$;

create trigger accounting_periods_stamp_state
  before insert or update on ledger.accounting_periods
  for each row execute function ledger.stamp_period_state();
