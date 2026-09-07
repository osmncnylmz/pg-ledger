-- Invariant #4: nothing may be posted into a closed period.
--
-- The rule, precisely:
--
--   * posted_at falls inside a period whose state is 'closed'  -> rejected.
--   * posted_at falls inside a period whose state is 'open'    -> accepted.
--   * posted_at falls outside every period                     -> accepted,
--     unless the tenant is configured with periods_required, in which case it
--     is rejected. Periods are opt-in per tenant; a tenant that has committed
--     to them cannot post outside the calendar it declared.
--
-- This is a BEFORE ROW trigger, not a deferred one: unlike balance, the
-- property is decidable from the single row being inserted, so failing
-- immediately gives the caller a better error and does less work.

create function ledger.assert_open_period() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_period   ledger.accounting_periods%rowtype;
  v_required boolean;
begin
  select * into v_period
    from ledger.accounting_periods
   where tenant_id = new.tenant_id
     and period @> new.posted_at;

  if found then
    if v_period.state = 'closed' then
      raise exception 'accounting period % is closed; cannot post at %',
        v_period.name, new.posted_at
        using errcode = 'LG003',
              detail  = format('period=%s range=%s closed_at=%s',
                               v_period.name, v_period.period, v_period.closed_at),
              hint    = 'Post into an open period, or reopen the period first.';
    end if;

    return new;
  end if;

  select periods_required into v_required
    from ledger.tenants
   where id = new.tenant_id;

  if coalesce(v_required, false) then
    raise exception 'no accounting period covers %', new.posted_at
      using errcode = 'LG006',
            detail  = format('tenant=%s posted_at=%s', new.tenant_id, new.posted_at),
            hint    = 'This tenant requires every entry to fall inside a defined period.';
  end if;

  return new;
end
$$;

create trigger journal_entries_open_period
  before insert on ledger.journal_entries
  for each row execute function ledger.assert_open_period();
