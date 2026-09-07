-- The journal: entries and their lines. Append-only (see 0007_immutability).
--
-- Each entry declares one currency, and a line's currency is tied to it by a
-- *composite foreign key*:
--
--     foreign key (entry_id, currency) references journal_entries (id, currency)
--
-- So a mixed-currency entry is never "checked" at all. It is unrepresentable:
-- no trigger to forget to install, no race window between reading the entry
-- and inserting the line.

create table ledger.journal_entries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references ledger.tenants (id),

  -- Unique per tenant: the same key posted twice yields one entry.
  idempotency_key    text not null,

  posted_at          timestamptz not null,
  description        text not null,
  currency           ledger.currency_code not null,

  -- Set on the *reversing* entry, pointing at the entry it reverses. The link
  -- lives on the new row precisely because the old row can never be updated
  -- again -- see 0007.
  reverses_entry_id  uuid,

  created_at         timestamptz not null default now(),

  constraint journal_entries_idempotency_key_key unique (tenant_id, idempotency_key),
  constraint journal_entries_tenant_id_key       unique (tenant_id, id),
  -- Target of journal_lines' currency foreign key.
  constraint journal_entries_id_currency_key     unique (id, currency),
  -- An entry can be reversed at most once. NULLs are distinct in a unique
  -- constraint, so ordinary entries are unaffected.
  constraint journal_entries_one_reversal_key    unique (tenant_id, reverses_entry_id),

  constraint journal_entries_reverses_same_tenant
    foreign key (tenant_id, reverses_entry_id)
    references ledger.journal_entries (tenant_id, id),

  constraint journal_entries_not_self_reversing check (reverses_entry_id is distinct from id),
  constraint journal_entries_description_present check (length(btrim(description)) > 0),
  constraint journal_entries_idempotency_key_present check (length(btrim(idempotency_key)) > 0)
);

create index journal_entries_tenant_posted_at_idx
  on ledger.journal_entries (tenant_id, posted_at, id);

create table ledger.journal_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  entry_id     uuid not null,
  line_no      integer not null,
  account_id   uuid not null,
  direction    ledger.entry_direction not null,

  -- Money is numeric. Never float, never an integer count of minor units that
  -- silently assumes two decimal places.
  amount       numeric(20, 4) not null,
  currency     ledger.currency_code not null,
  memo         text,

  constraint journal_lines_amount_positive check (amount > 0),
  constraint journal_lines_line_no_positive check (line_no > 0),
  constraint journal_lines_entry_line_no_key unique (entry_id, line_no),

  constraint journal_lines_entry_fkey
    foreign key (tenant_id, entry_id)
    references ledger.journal_entries (tenant_id, id),

  -- Makes a mixed-currency entry unrepresentable.
  constraint journal_lines_currency_matches_entry
    foreign key (entry_id, currency)
    references ledger.journal_entries (id, currency),

  constraint journal_lines_account_fkey
    foreign key (tenant_id, account_id)
    references ledger.accounts (tenant_id, id)
);

-- Two columns, not one. Every read of this table has a tenant_id predicate
-- bolted on by row level security, and with only entry_id indexed the planner
-- pairs this index with journal_lines_account_idx in a BitmapAnd that rescans
-- the account index once per entry -- 68-92 ms for a trial balance instead of
-- 4. entry_id has to lead so that the balance trigger's single-column lookup
-- still uses the index.
create index journal_lines_entry_idx on ledger.journal_lines (entry_id, tenant_id);
create index journal_lines_account_idx
  on ledger.journal_lines (tenant_id, account_id, currency);

comment on constraint journal_lines_currency_matches_entry on ledger.journal_lines is
  'Composite FK to (journal_entries.id, currency): a line cannot carry a currency other than its entry''s.';
comment on constraint journal_lines_amount_positive on ledger.journal_lines is
  'Amounts are magnitudes. Sign is carried by direction, never by the number.';
