-- Postings may only touch leaf accounts. A parent in the chart of accounts is
-- a rollup, not a place to put money, and allowing both postings and children
-- on one account makes every subtotal ambiguous. The rule needs two triggers,
-- because it can be broken from either side: by posting to an account that has
-- children, or by giving a parent to an account that already has postings.

create function ledger.assert_account_is_leaf() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
declare
  v_code text;
begin
  select a.code into v_code
    from ledger.accounts a
   where a.id = new.account_id
     and exists (select 1 from ledger.accounts c where c.parent_id = a.id);

  if found then
    raise exception 'account % is a rollup account and cannot be posted to', v_code
      using errcode = 'LG007',
            detail  = format('account_id=%s', new.account_id),
            hint    = 'Post to a leaf account; parents aggregate their children.';
  end if;

  return null;
end
$$;

create trigger journal_lines_leaf_account
  after insert on ledger.journal_lines
  for each row execute function ledger.assert_account_is_leaf();

create function ledger.assert_parent_has_no_postings() returns trigger
  language plpgsql
  set search_path = ledger, pg_catalog
as $$
begin
  if new.parent_id is null then
    return null;
  end if;

  if exists (select 1 from ledger.journal_lines l where l.account_id = new.parent_id) then
    raise exception 'account % already has postings and cannot become a rollup account',
      (select code from ledger.accounts where id = new.parent_id)
      using errcode = 'LG007',
            detail  = format('parent_account_id=%s', new.parent_id),
            hint    = 'Move the postings with reversing entries before nesting accounts under this one.';
  end if;

  return null;
end
$$;

create trigger accounts_parent_has_no_postings
  after insert or update of parent_id on ledger.accounts
  for each row execute function ledger.assert_parent_has_no_postings();
