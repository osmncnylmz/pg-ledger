-- 0006_balanced_entries.sql
--
-- Invariant #1: for every journal entry, SUM(debits) = SUM(credits).
--
-- Why this cannot be a normal row-level trigger
-- ---------------------------------------------
-- A BEFORE/AFTER ROW trigger fires while the statement is running. At the
-- moment the first line of a two-line entry is inserted the entry is, by
-- construction, unbalanced -- there is exactly one line and it is a debit.
-- An ordinary trigger would reject every entry ever written, unless callers
-- were forced to insert all lines in a single statement, which is a rule the
-- database cannot enforce and which the moment you allow "add one more line
-- to this entry" collapses anyway.
--
-- A CONSTRAINT TRIGGER declared DEFERRABLE INITIALLY DEFERRED fires at
-- COMMIT instead, after every statement in the transaction has run. Lines may
-- be inserted one at a time, in any order, by any number of statements. The
-- books are allowed to be transiently unbalanced *inside* a transaction and
-- are never allowed to be unbalanced *between* transactions -- which is
-- exactly the accounting rule.
--
-- Two triggers are installed, because there are two ways to break balance:
--
--   * on journal_entries -- catches an entry created with no lines, or with
--     lines that do not add up.
--   * on journal_lines   -- catches a line appended to an entry that was
--     already balanced, in this or any later transaction.

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
