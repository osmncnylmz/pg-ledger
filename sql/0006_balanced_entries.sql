-- Invariant #1: for every journal entry, SUM(debits) = SUM(credits).
--
-- The check cannot run per row. A BEFORE/AFTER ROW trigger fires mid-statement,
-- while a two-line entry still has only its debit, so it would refuse every
-- entry ever written. DEFERRABLE INITIALLY DEFERRED holds the check until
-- COMMIT, when the transaction is done writing. The README works through why
-- "insert both lines in one statement" is not an acceptable alternative.
--
-- Two triggers, because there are two ways to break balance:
--
--   * on journal_entries -- an entry created with no lines, or with lines that
--     do not add up.
--   * on journal_lines   -- a line appended to an entry that was already
--     balanced, in this or any later transaction. A trigger on the entry table
--     alone never fires for that one.

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
  -- One function serves both triggers. PL/pgSQL prepares an expression the
  -- first time it is reached, so the branch not taken is never type-checked
  -- against the wrong row type.
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

comment on function ledger.assert_entry_balanced() is
  'Deferred constraint trigger body. Runs at COMMIT so lines may be inserted one statement at a time.';

create constraint trigger journal_entries_balanced
  after insert on ledger.journal_entries
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();

create constraint trigger journal_lines_keep_entry_balanced
  after insert on ledger.journal_lines
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();
