-- 0002_tenants.sql
--
-- Tenants. Everything else in the schema hangs off this table, and every
-- tenant-scoped table carries a redundant tenant_id column so that row level
-- security can be expressed as a single equality test with no joins.

create table ledger.tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null,
  name              text not null,
  base_currency     ledger.currency_code not null,

  -- When true, an entry may only be posted into a period that exists and is
  -- open. When false (the default) periods are advisory: an entry outside
  -- every defined period is accepted, but an entry inside a *closed* period
  -- is still rejected. See 0008_period_guard.sql.
  periods_required  boolean not null default false,

  created_at        timestamptz not null default now(),

  constraint tenants_slug_key unique (slug),
  constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

comment on table ledger.tenants is
  'One row per set of books. Provisioning is an administrative operation: ledger_app has SELECT only.';
