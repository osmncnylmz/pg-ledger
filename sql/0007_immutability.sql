-- Invariant #2: the journal is append-only.
--
-- Privileges are the first line of defence -- ledger_app is never granted
-- UPDATE or DELETE on the journal (see 0090_security.sql). Privileges are not
-- enough on their own: an owner can grant them back, a migration can run as
-- the owner, and a superuser ignores them entirely. The trigger below refuses
-- the operation for *every* role, table owner and superuser included, because
-- a trigger sits inside the write path instead of in front of it.
--
-- The only way to undo a posted entry is ledger.reverse_entry(), which posts
-- the mirror entry and links the two. See 0011_posting_api.sql.

create function ledger.reject_journal_mutation() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
begin
  raise exception 'the journal is append-only: % on %.% is not permitted',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'LG002',
          -- CASE is lazily evaluated: OLD is not assigned for a
          -- statement-level TRUNCATE trigger, so it must not be touched there.
          detail  = case
                      when tg_op = 'TRUNCATE' then format('table=%s', tg_table_name)
                      else format('table=%s row=%s', tg_table_name, old.id)
                    end,
          hint    = 'Correct a posted entry with ledger.reverse_entry(entry_id), which posts the mirror entry.';
end
$$;

create trigger journal_entries_immutable
  before update or delete on ledger.journal_entries
  for each row execute function ledger.reject_journal_mutation();

create trigger journal_lines_immutable
  before update or delete on ledger.journal_lines
  for each row execute function ledger.reject_journal_mutation();

-- TRUNCATE bypasses row-level triggers, so it needs its own statement-level
-- guard. Without these two, "DELETE is impossible" would be a lie one
-- keystroke wide.
create trigger journal_entries_no_truncate
  before truncate on ledger.journal_entries
  for each statement execute function ledger.reject_journal_mutation();

create trigger journal_lines_no_truncate
  before truncate on ledger.journal_lines
  for each statement execute function ledger.reject_journal_mutation();
