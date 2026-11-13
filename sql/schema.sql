-- RECONSTRUCTED FROM CODE (api/*.js), not exported from the live database.
-- The column list is what the code reads and writes; the TYPES, defaults and constraints are INFERRED and
-- may differ from production. When the owner has run sql/export-schema.sql and sent the result, diff this
-- file against it and correct it (follow-up). Until then treat production as the source of truth.
--
-- Table, column and function statements are "create table if not exists" / "add column if not exists" /
-- "create or replace", so they add nothing to an object that already exists. The one exception is
-- "alter table ... enable row level security", which runs on four LIVE tables (events, rsvps,
-- pending_checkouts, checkout_abandonments) and DOES change them if RLS is still off there. What it does:
-- with RLS on and no policies, the anon and authenticated roles can read or write nothing. The app is not
-- affected: the API uses the service-role key (server side only), which bypasses RLS, and no page talks to
-- Supabase directly. The same statement is in sql/checkout_abandonments.sql. Read this before running the
-- file on production; it is meant as a reference and for building an empty test database. The release-two
-- additions are in sql/release-two-migration.sql (the same objects are repeated here so this file is the
-- whole picture).

-- events: one row per event. paid_at NULL = unpaid draft (invisible to guests).
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  customer_name text,
  customer_email text,
  customer_phone text,
  event_type text,
  event_name text,
  hebrew_date text,
  gregorian_date date,
  event_time text,
  location text,
  address text,
  extra_note text,
  dashboard_password text,
  paid_at timestamptz,
  active boolean default true,
  final_responses integer,          -- headcount snapshot, written once when a past event is closed (cleanup.js)
  final_guests integer,
  receipt_number integer,           -- release two: stored receipt number (gapless counter)
  refunded_at timestamptz,          -- release two: NULL = not refunded; set from /admin
  picture_path text                 -- picture P1: optional JPEG, ok/<uuid>.jpg in bucket event-pictures
);
alter table public.events add column if not exists receipt_number integer;
alter table public.events add column if not exists refunded_at timestamptz;
alter table public.events add column if not exists picture_path text;
create unique index if not exists events_receipt_number_key
  on public.events (receipt_number) where receipt_number is not null;
alter table public.events enable row level security;

-- rsvps: guest replies, removed by cleanup.js 30 days after the event.
create table if not exists public.rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id),
  name text,
  attending boolean,
  guests integer,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.rsvps enable row level security;

-- pending_checkouts: "reached checkout, not yet paid"; purged 7 days after updated_at (personal data).
create table if not exists public.pending_checkouts (
  id text primary key,               -- the browser's checkoutId
  customer_name text,
  customer_email text,
  customer_phone text,
  event_type text,
  event_name text,
  gregorian_date date,
  event_time text,
  location text,
  updated_at timestamptz not null default now(),
  notified boolean not null default false
);
alter table public.pending_checkouts enable row level security;

-- checkout_abandonments: anonymous permanent count (same definition as sql/checkout_abandonments.sql).
create table if not exists public.checkout_abandonments (
  id bigint generated always as identity primary key,
  abandoned_at timestamptz not null default now(),
  event_type text
);
alter table public.checkout_abandonments enable row level security;

-- receipt_counter: the last receipt number handed out (one row). A counter, so a deleted event's number is never reused.
create table if not exists public.receipt_counter (
  id integer primary key check (id = 1),
  last_number integer not null default 0
);
insert into public.receipt_counter (id, last_number) values (1, 0) on conflict (id) do nothing;
alter table public.receipt_counter enable row level security;

-- rate_limits: request counters for the public endpoints (hashed keys), purged daily by api/cleanup.js.
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;

-- Functions (identical to sql/release-two-migration.sql).
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
    return null;
  end if;
  if v_num is not null then
    return v_num;
  end if;
  update public.receipt_counter set last_number = last_number + 1 where id = 1 returning last_number into v_num;
  update public.events set receipt_number = v_num where slug = p_slug;
  return v_num;
end;
$$;

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

revoke all on function public.assign_receipt_number(text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.assign_receipt_number(text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
