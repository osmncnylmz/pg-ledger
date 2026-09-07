-- 0011_posting_api.sql
--
-- The write API: post_entry and reverse_entry.
--
-- These functions are deliberately thin. They resolve account codes, shape
-- the rows and hand them to the tables. They do not check that the entry
-- balances, that the currencies agree, or that the period is open -- the
-- constraints and triggers own those questions, and a second copy of the rule
-- here would be a copy that can rot.
--
-- Invariant #5, idempotent posting, lives here. It is one INSERT ... ON
-- CONFLICT DO NOTHING against the unique index on (tenant_id,
-- idempotency_key). Two concurrent transactions posting the same key both
-- reach the index; one inserts, the other blocks on the index tuple, wakes up
-- after the first commits, inserts nothing, and reads back the winner's row.
-- The result is one entry and two callers holding the same entry id.

create type ledger.post_result as (
  entry_id uuid,
  created  boolean
);

create function ledger.resolve_account(p_tenant_id uuid, p_code text) returns uuid
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
declare
  v_id     uuid;
  v_active boolean;
begin
  select id, is_active into v_id, v_active
    from ledger.accounts
   where tenant_id = p_tenant_id and code = p_code;

  if v_id is null then
    raise exception 'account % does not exist in this chart of accounts', p_code
      using errcode = 'LG012',
            detail  = format('tenant=%s code=%s', p_tenant_id, p_code);
  end if;

  if not v_active then
    raise exception 'account % is inactive and cannot be posted to', p_code
      using errcode = 'LG013',
            detail  = format('tenant=%s code=%s', p_tenant_id, p_code);
  end if;

  return v_id;
end
$$;

-- p_lines is a JSON array of objects:
--   [{"account_code": "1000", "direction": "debit", "amount": "150.00", "memo": null}, ...]
-- Line numbers are the array positions, so the caller's ordering is preserved
-- in the books.
create function ledger.post_entry(
  p_tenant_id       uuid,
  p_idempotency_key text,
  p_posted_at       timestamptz,
  p_description     text,
  p_currency        ledger.currency_code,
  p_lines           jsonb
) returns ledger.post_result
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_entry_id uuid;
begin
  if p_tenant_id is distinct from ledger.current_tenant_id() then
    raise exception 'tenant mismatch: session is scoped to %, called with %',
      ledger.current_tenant_id(), p_tenant_id
      using errcode = 'LG005',
            hint = 'Set app.tenant_id for the session that owns these books.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'lines must be a JSON array, got %', coalesce(jsonb_typeof(p_lines), 'null')
      using errcode = 'LG014';
  end if;

  insert into ledger.journal_entries
    (tenant_id, idempotency_key, posted_at, description, currency)
  values
    (p_tenant_id, p_idempotency_key, p_posted_at, p_description, p_currency)
  on conflict on constraint journal_entries_idempotency_key_key do nothing
  returning id into v_entry_id;

  if v_entry_id is null then
    -- Lost the race, or a straightforward retry. Either way the winning row
    -- is the answer.
    select id into v_entry_id
      from ledger.journal_entries
     where tenant_id = p_tenant_id
       and idempotency_key = p_idempotency_key;

    if v_entry_id is null then
      raise exception 'idempotency key % conflicted but no entry is visible', p_idempotency_key
        using errcode = 'LG015';
    end if;

    return (v_entry_id, false)::ledger.post_result;
  end if;

  insert into ledger.journal_lines
    (tenant_id, entry_id, line_no, account_id, direction, amount, currency, memo)
  select p_tenant_id,
         v_entry_id,
         l.ord::integer,
         ledger.resolve_account(p_tenant_id, l.elem ->> 'account_code'),
         (l.elem ->> 'direction')::ledger.entry_direction,
         (l.elem ->> 'amount')::numeric(20, 4),
         p_currency,
         l.elem ->> 'memo'
    from jsonb_array_elements(p_lines) with ordinality as l(elem, ord);

  return (v_entry_id, true)::ledger.post_result;
end
$$;

comment on function ledger.post_entry(uuid, text, timestamptz, text, ledger.currency_code, jsonb) is
  'Posts one journal entry. Idempotent on (tenant_id, idempotency_key). Performs no accounting validation of its own.';

-- The only sanctioned way to undo a posted entry.
create function ledger.reverse_entry(
  p_entry_id        uuid,
  p_posted_at       timestamptz default null,
  p_description     text        default null,
  p_idempotency_key text        default null
) returns uuid
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_original ledger.journal_entries%rowtype;
  v_existing uuid;
  v_new_id   uuid;
begin
  select * into v_original
    from ledger.journal_entries
   where id = p_entry_id;

  if not found then
    raise exception 'journal entry % does not exist in this tenant', p_entry_id
      using errcode = 'LG008';
  end if;

  select id into v_existing
    from ledger.journal_entries
   where reverses_entry_id = p_entry_id;

  if v_existing is not null then
    raise exception 'journal entry % has already been reversed by %', p_entry_id, v_existing
      using errcode = 'LG009',
            detail  = format('reversal_entry_id=%s', v_existing);
  end if;

  insert into ledger.journal_entries
    (tenant_id, idempotency_key, posted_at, description, currency, reverses_entry_id)
  values
    (v_original.tenant_id,
     coalesce(p_idempotency_key, 'reversal:' || p_entry_id::text),
     coalesce(p_posted_at, now()),
     coalesce(p_description, 'Reversal of: ' || v_original.description),
     v_original.currency,
     p_entry_id)
  returning id into v_new_id;

  insert into ledger.journal_lines
    (tenant_id, entry_id, line_no, account_id, direction, amount, currency, memo)
  select l.tenant_id,
         v_new_id,
         l.line_no,
         l.account_id,
         case l.direction when 'debit' then 'credit' else 'debit' end::ledger.entry_direction,
         l.amount,
         l.currency,
         l.memo
    from ledger.journal_lines l
   where l.entry_id = p_entry_id
   order by l.line_no;

  return v_new_id;
end
$$;

comment on function ledger.reverse_entry(uuid, timestamptz, text, text) is
  'Posts the mirror of an entry and links the new entry to the old one. The original row is never touched.';

-- Entries with their reversal status. security_invoker means row level
-- security is evaluated as the querying role, not as the view owner.
create view ledger.journal_entry_status
  with (security_invoker = true)
as
select e.id,
       e.tenant_id,
       e.idempotency_key,
       e.posted_at,
       e.description,
       e.currency,
       e.reverses_entry_id,
       r.id as reversed_by_entry_id,
       (r.id is not null) as is_reversed,
       e.created_at
  from ledger.journal_entries e
  left join ledger.journal_entries r on r.reverses_entry_id = e.id;
