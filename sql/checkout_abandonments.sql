-- Run in the Supabase SQL editor; safe to run more than once.
-- Anonymous, permanent log of confirmed checkout abandonments — no name/email/phone,
-- so it can be retained indefinitely without the privacy concerns of pending_checkouts
-- (which still gets purged after 7 days, unchanged, in api/_sweep.js).
create table if not exists public.checkout_abandonments (
  id bigint generated always as identity primary key,
  abandoned_at timestamptz not null default now(),
  event_type text
);

-- The API only ever accesses this via the Supabase service-role key (server-side),
-- which bypasses RLS — enabling RLS with no policies just blocks any other access path.
alter table public.checkout_abandonments enable row level security;
