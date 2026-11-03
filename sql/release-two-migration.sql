-- Release two migration. Run ONCE by the owner in the Supabase SQL editor (paste the whole file, Run).
-- Safe to run again: every statement is "if not exists" / "create or replace" / "on conflict do nothing",
-- and the backfill only touches events that have no receipt number yet. No drop, no delete, no truncate:
-- nothing is removed and no existing value is overwritten. One transaction: all or nothing.
--
-- What it adds (all additive):
--   events.receipt_number   integer, unique when set. The receipt number stored when the event is paid.
--   events.refunded_at      timestamptz. NULL = not refunded. Set from /admin ("↩️ זיכוי"); drives the revenue figure.
--   receipt_counter         one row, last number handed out. A counter (not a count of events), so deleting
--                           the newest event never makes its number be used again.
--   assign_receipt_number   gapless, idempotent: returns the stored number, or takes the next one (paid events only).
--   rate_limits             request counters for the public endpoints (hashed keys, purged daily by cleanup.js).
--   rate_limit_hit          atomic counter used by api/_ratelimit.js.
--
-- Deploy order: run this file first, then merge the release. The release also works if it goes live first
-- (it falls back to the old behaviour and logs), but marking refunds needs this migration.
--
-- Read-only checks afterwards (expect the six existing paid events numbered 1..6 in paid_at order):
--   select slug, paid_at, receipt_number from public.events where paid_at is not null order by receipt_number;
--   select * from public.receipt_counter;                       -- last_number = 6 (or the highest number so far)

begin;

-- 1. Columns -------------------------------------------------------------------------------------------
alter table public.events add column if not exists receipt_number integer;
alter table public.events add column if not exists refunded_at timestamptz;

create unique index if not exists events_receipt_number_key
  on public.events (receipt_number) where receipt_number is not null;

-- 2. Receipt counter -----------------------------------------------------------------------------------
create table if not exists public.receipt_counter (
  id integer primary key check (id = 1),
  last_number integer not null default 0
);
insert into public.receipt_counter (id, last_number) values (1, 0) on conflict (id) do nothing;
alter table public.receipt_counter enable row level security;

-- 3. Backfill: number the existing paid events 1..n in paid_at order (ties by id). Re-run safe: continues
--    after the highest number already used and skips events that already have one.
with b as (select coalesce(max(receipt_number), 0) m from public.events),
o as (select id, row_number() over (order by paid_at, id) rn from public.events
      where paid_at is not null and receipt_number is null)
update public.events e set receipt_number = b.m + o.rn from o, b where e.id = o.id;

update public.receipt_counter set last_number =
  greatest(last_number, (select coalesce(max(receipt_number), 0) from public.events)) where id = 1;

-- 4. assign_receipt_number(p_slug): idempotent and gapless. The event row is locked first, then the counter
--    row, so two payments never get the same number; if the transaction rolls back the number is not used up.
create or replace function public.assign_receipt_number(p_slug text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num integer;
  v_paid timestamptz;
begin
  select receipt_number, paid_at into v_num, v_paid from public.events where slug = p_slug for update;
  if not found or v_paid is null then
    return null;                       -- unknown slug or an unpaid draft: no number
  end if;
  if v_num is not null then
    return v_num;                      -- already numbered: never changes
  end if;
  update public.receipt_counter set last_number = last_number + 1 where id = 1 returning last_number into v_num;
  update public.events set receipt_number = v_num where slug = p_slug;
  return v_num;
end;
$$;

-- 5. Rate limiting -------------------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;

-- rate_limit_hit(p_key, p_window_s, p_limit): counts one call in the key's current window; true = allowed.
create or replace function public.rate_limit_hit(p_key text, p_window_s integer, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when r.window_start + make_interval(secs => p_window_s) <= now() then now() else r.window_start end,
    hits         = case when r.window_start + make_interval(secs => p_window_s) <= now() then 1     else r.hits + 1 end
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

-- 6. Only the server (service role) may call the two functions, not the public API roles.
revoke all on function public.assign_receipt_number(text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.assign_receipt_number(text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

commit;
