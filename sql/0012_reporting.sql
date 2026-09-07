-- The read side. Everything here is a set-returning function, so the reports
-- are versioned with the schema instead of being reimplemented in every
-- service that wants them.
--
-- Row level security already restricts these functions to the session's
-- tenant, so the p_tenant_id argument is strictly a guard: without it, asking
-- for another tenant's numbers returns a plausible empty report instead of an
-- error. assert_current_tenant turns that quiet wrong answer into a loud one.

create function ledger.assert_current_tenant(p_tenant_id uuid) returns void
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  if p_tenant_id is distinct from ledger.current_tenant_id() then
    raise exception 'tenant mismatch: session is scoped to %, called with %',
      ledger.current_tenant_id(), p_tenant_id
      using errcode = 'LG005',
            hint = 'Set app.tenant_id for the session that owns these books.';
  end if;
end
$$;

-- Every account with movement up to p_as_of, in debit/credit columns. The sum
-- of the debit column always equals the sum of the credit column, per
-- currency: invariant #1 observed from the outside.

create function ledger.trial_balance(
  p_tenant_id uuid,
  p_as_of     timestamptz default now()
) returns table (
  account_id     uuid,
  code           text,
  name           text,
  type           ledger.account_type,
  normal_balance ledger.normal_balance,
  currency       ledger.currency_code,
  debits         numeric(24, 4),
  credits        numeric(24, 4),
  balance        numeric(24, 4),
  normal_amount  numeric(24, 4)
)
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  return query
  select a.id,
         a.code,
         a.name,
         a.type,
         a.normal_balance,
         m.currency,
         m.debits,
         m.credits,
         (m.debits - m.credits)::numeric(24, 4),
         (case a.normal_balance
            when 'debit' then m.debits - m.credits
            else m.credits - m.debits
          end)::numeric(24, 4)
    from (
      select l.account_id,
             l.currency,
             coalesce(sum(l.amount) filter (where l.direction = 'debit'), 0)::numeric(24, 4)  as debits,
             coalesce(sum(l.amount) filter (where l.direction = 'credit'), 0)::numeric(24, 4) as credits
        from ledger.journal_lines l
        join ledger.journal_entries e on e.id = l.entry_id
       where l.tenant_id = p_tenant_id
         and e.posted_at <= p_as_of
       group by l.account_id, l.currency
    ) m
    join ledger.accounts a on a.id = m.account_id
   order by a.code, m.currency;
end
$$;

-- Every posting to one account, with a running balance carried in the sign of
-- the account's normal balance: a debit increases an asset and decreases a
-- liability, without the caller having to remember which is which.
--
-- The window frame starts at the beginning of time and the date filter is
-- applied *after* the window, so the first row of a statement for March opens
-- with February's closing balance rather than with zero.

create function ledger.account_statement(
  p_tenant_id    uuid,
  p_account_code text,
  p_from         timestamptz default '-infinity',
  p_to           timestamptz default 'infinity'
) returns table (
  posted_at       timestamptz,
  entry_id        uuid,
  line_no         integer,
  description     text,
  memo            text,
  currency        ledger.currency_code,
  direction       ledger.entry_direction,
  debit           numeric(24, 4),
  credit          numeric(24, 4),
  signed_amount   numeric(24, 4),
  running_balance numeric(24, 4)
)
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
declare
  v_account_id uuid;
  v_normal     text;
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  -- The account's normal balance is the same value for every row of the
  -- statement, so it is read once into a variable rather than looked up per
  -- line. Measured, the join form the planner would otherwise produce costs
  -- nothing -- it hoists the lookup out itself. What does cost is a
  -- correlated subquery or a PL/pgSQL call evaluated per row, and reading the
  -- value into a variable makes it impossible for the query to drift into
  -- either of those. See the Performance section of the README for figures.
  select a.id, a.normal_balance::text into v_account_id, v_normal
    from ledger.accounts a
   where a.tenant_id = p_tenant_id and a.code = p_account_code;

  if v_account_id is null then
    raise exception 'account % does not exist in this chart of accounts', p_account_code
      using errcode = 'LG012';
  end if;

  return query
  with movements as (
    select e.posted_at,
           l.entry_id,
           l.line_no,
           e.description,
           l.memo,
           l.currency,
           l.direction,
           (case when l.direction = 'debit'  then l.amount else 0 end)::numeric(24, 4) as debit,
           (case when l.direction = 'credit' then l.amount else 0 end)::numeric(24, 4) as credit,
           (case when l.direction::text = v_normal
                   then l.amount else -l.amount end)::numeric(24, 4) as signed_amount
      from ledger.journal_lines l
      join ledger.journal_entries e on e.id = l.entry_id
     where l.tenant_id = p_tenant_id
       and l.account_id = v_account_id
       and e.posted_at <= p_to
  ),
  running as (
    -- The window has to be computed in its own query level: WHERE is applied
    -- before window functions, so filtering by p_from in the same SELECT
    -- would hide the earlier rows from the frame and restart the balance at
    -- zero instead of bringing it forward.
    select m.*,
           sum(m.signed_amount) over (
             partition by m.currency
             order by m.posted_at, m.entry_id, m.line_no
             rows between unbounded preceding and current row
           )::numeric(24, 4) as running_balance
      from movements m
  )
  select r.posted_at,
         r.entry_id,
         r.line_no,
         r.description,
         r.memo,
         r.currency,
         r.direction,
         r.debit,
         r.credit,
         r.signed_amount,
         r.running_balance
    from running r
   where r.posted_at >= p_from
   order by r.posted_at, r.entry_id, r.line_no;
end
$$;

-- The rollup is two recursive CTEs. The first walks the tree downwards from
-- its roots to attach a depth and a path to every account, which is what makes
-- an indented report possible. The second is the transitive closure
-- ancestor -> all descendants, which is what lets a parent's subtotal be a
-- single grouped sum instead of an N+1 walk from the application.
--
-- The row type is named so that balance_sheet and income_statement can be
-- one-line wrappers returning the same shape.
create type ledger.rollup_row as (
  account_id     uuid,
  code           text,
  name           text,
  type           ledger.account_type,
  normal_balance ledger.normal_balance,
  depth          integer,
  path           text[],
  is_leaf        boolean,
  currency       ledger.currency_code,
  own_amount     numeric(24, 4),
  subtree_amount numeric(24, 4)
);

create function ledger.account_rollup(
  p_tenant_id uuid,
  p_types     ledger.account_type[],
  p_from      timestamptz,
  p_to        timestamptz
) returns setof ledger.rollup_row
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  return query
  with recursive hierarchy as (
      select a.id, a.parent_id, a.code, a.name, a.type, a.normal_balance,
             0 as depth,
             array[a.code] as path
        from ledger.accounts a
       where a.tenant_id = p_tenant_id
         and a.parent_id is null
         and a.type = any (p_types)
      union all
      select c.id, c.parent_id, c.code, c.name, c.type, c.normal_balance,
             h.depth + 1,
             h.path || c.code
        from hierarchy h
        join ledger.accounts c
          on c.parent_id = h.id
         and c.tenant_id = p_tenant_id
  ),
  closure as (
      select h.id as ancestor_id, h.id as descendant_id
        from hierarchy h
      union all
      select cl.ancestor_id, c.id
        from closure cl
        join ledger.accounts c
          on c.parent_id = cl.descendant_id
         and c.tenant_id = p_tenant_id
  ),
  movements as (
      select l.account_id,
             l.currency,
             (coalesce(sum(l.amount) filter (where l.direction = 'debit'), 0)
              - coalesce(sum(l.amount) filter (where l.direction = 'credit'), 0))::numeric(24, 4) as signed
        from ledger.journal_lines l
        join ledger.journal_entries e on e.id = l.entry_id
       where l.tenant_id = p_tenant_id
         and e.posted_at >= p_from
         and e.posted_at <= p_to
       group by l.account_id, l.currency
  ),
  subtree as (
      select cl.ancestor_id as account_id,
             m.currency,
             sum(m.signed)::numeric(24, 4) as signed
        from closure cl
        join movements m on m.account_id = cl.descendant_id
       group by cl.ancestor_id, m.currency
  )
  select h.id,
         h.code,
         h.name,
         h.type,
         h.normal_balance,
         h.depth,
         h.path,
         not exists (select 1 from ledger.accounts c where c.parent_id = h.id) as is_leaf,
         s.currency,
         (case h.normal_balance
            when 'debit' then coalesce(o.signed, 0) else -coalesce(o.signed, 0)
          end)::numeric(24, 4) as own_amount,
         (case h.normal_balance
            when 'debit' then s.signed else -s.signed
          end)::numeric(24, 4) as subtree_amount
    from hierarchy h
    join subtree s on s.account_id = h.id
    left join movements o on o.account_id = h.id and o.currency = s.currency
   order by h.path, s.currency;
end
$$;

create function ledger.balance_sheet(
  p_tenant_id uuid,
  p_as_of     timestamptz default now()
) returns setof ledger.rollup_row
  language sql
  stable
  set search_path = ledger, pg_catalog
as $$
  select * from ledger.account_rollup(
    p_tenant_id,
    array['asset', 'liability', 'equity']::ledger.account_type[],
    '-infinity'::timestamptz,
    p_as_of
  )
$$;

create function ledger.income_statement(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
) returns setof ledger.rollup_row
  language sql
  stable
  set search_path = ledger, pg_catalog
as $$
  select * from ledger.account_rollup(
    p_tenant_id,
    array['revenue', 'expense']::ledger.account_type[],
    p_from,
    p_to
  )
$$;

-- Assets = Liabilities + Equity + (Revenue - Expenses), per currency.
-- The difference column is arithmetically forced to zero by invariant #1.
-- Printing it anyway turns an assumption into an observation.
create function ledger.accounting_equation(
  p_tenant_id uuid,
  p_as_of     timestamptz default now()
) returns table (
  currency    ledger.currency_code,
  assets      numeric(24, 4),
  liabilities numeric(24, 4),
  equity      numeric(24, 4),
  revenue     numeric(24, 4),
  expenses    numeric(24, 4),
  net_income  numeric(24, 4),
  difference  numeric(24, 4)
)
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  return query
  with signed as (
    select t.currency,
           t.type,
           sum(t.balance)::numeric(24, 4) as signed
      from ledger.trial_balance(p_tenant_id, p_as_of) t
     group by t.currency, t.type
  ),
  totals as (
    select s.currency,
           coalesce(sum(s.signed) filter (where s.type = 'asset'), 0)      as assets,
           -coalesce(sum(s.signed) filter (where s.type = 'liability'), 0) as liabilities,
           -coalesce(sum(s.signed) filter (where s.type = 'equity'), 0)    as equity,
           -coalesce(sum(s.signed) filter (where s.type = 'revenue'), 0)   as revenue,
           coalesce(sum(s.signed) filter (where s.type = 'expense'), 0)    as expenses
      from signed s
     group by s.currency
  )
  select t.currency,
         t.assets::numeric(24, 4),
         t.liabilities::numeric(24, 4),
         t.equity::numeric(24, 4),
         t.revenue::numeric(24, 4),
         t.expenses::numeric(24, 4),
         (t.revenue - t.expenses)::numeric(24, 4),
         (t.assets - t.liabilities - t.equity - (t.revenue - t.expenses))::numeric(24, 4)
    from totals t
   order by t.currency;
end
$$;

create function ledger.current_balances(p_tenant_id uuid)
returns table (
  account_id     uuid,
  code           text,
  name           text,
  type           ledger.account_type,
  normal_balance ledger.normal_balance,
  currency       ledger.currency_code,
  debit_total    numeric(24, 4),
  credit_total   numeric(24, 4),
  balance        numeric(24, 4),
  normal_amount  numeric(24, 4),
  line_count     bigint,
  updated_at     timestamptz
)
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  return query
  select a.id, a.code, a.name, a.type, a.normal_balance, b.currency,
         b.debit_total, b.credit_total, b.balance,
         (case a.normal_balance when 'debit' then b.balance else -b.balance end)::numeric(24, 4),
         b.line_count,
         b.updated_at
    from ledger.account_balances b
    join ledger.accounts a on a.id = b.account_id
   where b.tenant_id = p_tenant_id
   order by a.code, b.currency;
end
$$;

-- The showpiece test calls this and asserts it returns no rows. A full outer
-- join between the incrementally maintained cache and a from-scratch
-- recomputation catches every failure mode a cache has: a missed insert, a
-- double-applied insert, a row that should have been deleted, drift in one
-- currency of a multi-currency account.
create function ledger.reconcile_balances(p_tenant_id uuid)
returns table (
  account_id         uuid,
  code               text,
  currency           ledger.currency_code,
  cached_debit       numeric(24, 4),
  actual_debit       numeric(24, 4),
  cached_credit      numeric(24, 4),
  actual_credit      numeric(24, 4),
  cached_line_count  bigint,
  actual_line_count  bigint
)
  language plpgsql
  stable
  set search_path = ledger, pg_catalog
as $$
begin
  perform ledger.assert_current_tenant(p_tenant_id);

  return query
  with actual as (
    select l.account_id,
           l.currency,
           coalesce(sum(l.amount) filter (where l.direction = 'debit'), 0)::numeric(24, 4)  as debit_total,
           coalesce(sum(l.amount) filter (where l.direction = 'credit'), 0)::numeric(24, 4) as credit_total,
           count(*)::bigint as line_count
      from ledger.journal_lines l
     where l.tenant_id = p_tenant_id
     group by l.account_id, l.currency
  ),
  cached as (
    select b.account_id, b.currency, b.debit_total, b.credit_total, b.line_count
      from ledger.account_balances b
     where b.tenant_id = p_tenant_id
  )
  select coalesce(c.account_id, x.account_id),
         a.code,
         coalesce(c.currency, x.currency),
         c.debit_total,
         x.debit_total,
         c.credit_total,
         x.credit_total,
         c.line_count,
         x.line_count
    from cached c
    full outer join actual x
      on x.account_id = c.account_id and x.currency = c.currency
    left join ledger.accounts a on a.id = coalesce(c.account_id, x.account_id)
   where c.account_id is null
      or x.account_id is null
      or c.debit_total  is distinct from x.debit_total
      or c.credit_total is distinct from x.credit_total
      or c.line_count   is distinct from x.line_count
   order by a.code, coalesce(c.currency, x.currency);
end
$$;

comment on function ledger.reconcile_balances(uuid) is
  'Returns the rows where the incremental balance cache disagrees with a full recomputation. Empty means the cache is exact.';
