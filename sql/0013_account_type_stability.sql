-- 0013_account_type_stability.sql
--
-- An account's type is fixed once it has been posted to.
--
-- normal_balance is GENERATED ALWAYS from type, so changing the type of an
-- account changes the sign every report gives to that account's history. An
-- asset with a debit balance of 100 becomes a revenue account with a normal
-- amount of -100 without a single journal row being touched. The journal is
-- append-only, but the lens the journal is read through was not, so posted
-- books could still be rewritten by a plain UPDATE -- one that ledger_app is
-- granted, because it needs UPDATE on accounts to rename or deactivate one.
--
-- This is the mirror of accounts_parent_has_no_postings in 0009: that trigger
-- refuses to turn a posted-to account into a rollup, this one refuses to
-- reclassify it. Both say the same thing -- once money has moved through an
-- account, the shape of that account is history and history does not change.
--
-- Renaming, reparenting within the same type, and deactivating all stay
-- available: only `type` is frozen, and only after the first posting.

create function ledger.assert_account_type_stable() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
begin
  if new.type = old.type then
    return null;
  end if;

  if exists (select 1 from ledger.journal_lines l where l.account_id = old.id) then
    raise exception 'account % has postings and cannot be reclassified from % to %',
      old.code, old.type, new.type
      using errcode = 'LG011',
            detail  = format('account_id=%s old_type=%s new_type=%s', old.id, old.type, new.type),
            hint    = 'Open a new account of the correct type and move the balance with a reversing entry.';
  end if;

  return null;
end
$$;

comment on function ledger.assert_account_type_stable() is
  'Refuses a change of accounts.type once the account has journal lines: normal_balance is derived from type, so reclassifying would re-sign posted history.';

create trigger accounts_type_stable
  after update of type on ledger.accounts
  for each row execute function ledger.assert_account_type_stable();
