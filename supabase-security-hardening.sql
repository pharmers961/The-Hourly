-- The Hourly: security hardening migration.
--
-- Apply this AFTER supabase-schema.sql, in the Supabase dashboard:
--   SQL Editor -> New query -> paste -> Run.
-- Nothing here runs automatically; it only takes effect once you run it.
-- Every statement is idempotent and safe to re-run.
--
-- This file closes the access-control gaps found in the security audit:
--   1. The `profiles` table was readable by EVERY authenticated user, exposing
--      every user's email, name, timezone, and last-active time across all
--      groups. It is now scoped to people you actually share a group with (plus
--      the authors of photos/comments you're allowed to see, so history still
--      renders names for members who have left a group).
--   2. The `notifications` insert policy allowed ANY authenticated user to write
--      a notification row to ANY profile id (which then fires a push). It is now
--      restricted to recipients you share a group with.
--   3. Removes the `debug_whoami` diagnostic function from production.
--
-- IMPORTANT: test the app after applying (view a group, open a photo with a
-- comment from someone who has left, post a comment, receive a notification).
-- To roll back, re-run supabase-schema.sql, which restores the original
-- policies.

-- ---------------------------------------------------------------------------
-- 1. Scope profile visibility
-- ---------------------------------------------------------------------------

-- True when the caller is allowed to see profile p_id: it's their own, they
-- share at least one group, or that person authored a photo/comment the caller
-- can already view (keeps names resolving for departed members in history).
create or replace function public.can_view_profile(p_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    p_id = public.my_profile_id()
    or exists (
      select 1
      from public.group_members gm_me
      join public.group_members gm_them on gm_them.group_id = gm_me.group_id
      where gm_me.profile_id = public.my_profile_id()
        and gm_them.profile_id = p_id
    )
    or exists (
      select 1 from public.photos ph
      where ph.profile_id = p_id and public.can_view_photo(ph.id)
    )
    or exists (
      select 1 from public.comments c
      where c.profile_id = p_id and public.can_view_photo(c.photo_id)
    )
$$;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  for select to authenticated using (public.can_view_profile(id));

-- ---------------------------------------------------------------------------
-- 2. Scope who you may send a notification to
-- ---------------------------------------------------------------------------

drop policy if exists "notifications send" on public.notifications;
create policy "notifications send" on public.notifications
  for insert to authenticated with check (
    exists (
      select 1
      from public.group_members gm_me
      join public.group_members gm_to on gm_to.group_id = gm_me.group_id
      where gm_me.profile_id = public.my_profile_id()
        and gm_to.profile_id = to_profile_id
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Drop the diagnostic helper from production
-- ---------------------------------------------------------------------------

drop function if exists public.debug_whoami();

-- ---------------------------------------------------------------------------
-- 4. Make photo storage private and served by signed URLs
--
-- The `photos` bucket was public: anyone who ever obtained a file URL (a
-- forwarded link, a CDN cache, browser history) could view that photo forever,
-- even after the uploader deleted their account. This flips the bucket to
-- private and adds a read policy so a URL can only be signed for a photo the
-- caller is already allowed to see. The client (src/api.ts) signs short-lived
-- URLs; deploy that client change together with this section.
-- ---------------------------------------------------------------------------

do $$
begin
  update storage.buckets set public = false where id = 'photos';
exception when others then
  raise notice 'Could not flip the photos bucket to private via SQL (%). Do it in the dashboard: Storage -> photos -> Settings -> turn off "Public bucket".', sqlerrm;
end $$;

do $$
begin
  drop policy if exists "photo read visible" on storage.objects;
  -- `name` is the object's storage path, which matches photos.image_path /
  -- photos.thumb_path exactly. Reads (and therefore signed-URL creation) are
  -- allowed only for a photo the caller can view.
  create policy "photo read visible" on storage.objects
    for select to authenticated using (
      bucket_id = 'photos'
      and exists (
        select 1 from public.photos ph
        where (ph.image_path = name or ph.thumb_path = name)
          and public.can_view_photo(ph.id)
      )
    );
exception when others then
  raise notice 'Could not create the storage read policy via SQL (%). Create it in the dashboard: Storage -> photos -> Policies -> New policy -> SELECT for authenticated.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Rate limiting
--
-- Caps how many rows one identity can insert per hour, so a single account
-- can't spam nudges/notifications/comments (each of which can fan out to a
-- push notification). Thresholds are generous — normal use never hits them.
-- ---------------------------------------------------------------------------

create or replace function public.rate_limit_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_col text := TG_ARGV[0];
  v_max int := TG_ARGV[1]::int;
  v_val uuid;
  v_count int;
begin
  v_val := (to_jsonb(NEW) ->> v_col)::uuid;
  execute format(
    'select count(*) from public.%I where %I = $1 and created_at > now() - interval ''1 hour''',
    TG_TABLE_NAME, v_col
  ) into v_count using v_val;
  if v_count >= v_max then
    raise exception 'Rate limit exceeded on %: too many in the last hour. Please slow down.', TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists nudges_rate_limit on public.nudges;
create trigger nudges_rate_limit before insert on public.nudges
  for each row execute function public.rate_limit_guard('from_profile_id', '200');

drop trigger if exists notifications_rate_limit on public.notifications;
create trigger notifications_rate_limit before insert on public.notifications
  for each row execute function public.rate_limit_guard('to_profile_id', '200');

drop trigger if exists comments_rate_limit on public.comments;
create trigger comments_rate_limit before insert on public.comments
  for each row execute function public.rate_limit_guard('profile_id', '120');

-- Note: sign-in email (magic link) rate limits are configured separately in
-- the Supabase dashboard: Authentication -> Rate Limits.

-- ---------------------------------------------------------------------------
-- 6. Report a photo as inappropriate
--
-- Backs the in-app "Report" button. Anyone can report a photo they can see;
-- one report per person per photo (re-reporting updates the reason). Review
-- open reports in the dashboard: Table Editor -> photo_reports (the service
-- role bypasses RLS, so all reports are visible there).
-- ---------------------------------------------------------------------------

create table if not exists public.photo_reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.photos(id) on delete cascade,
  reporter_profile_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (photo_id, reporter_profile_id)
);

create index if not exists photo_reports_photo_idx on public.photo_reports (photo_id);

alter table public.photo_reports enable row level security;

drop policy if exists "reports insert" on public.photo_reports;
create policy "reports insert" on public.photo_reports
  for insert to authenticated with check (
    reporter_profile_id = public.my_profile_id() and public.can_view_photo(photo_id)
  );

drop policy if exists "reports update own" on public.photo_reports;
create policy "reports update own" on public.photo_reports
  for update to authenticated
  using (reporter_profile_id = public.my_profile_id())
  with check (reporter_profile_id = public.my_profile_id());

drop policy if exists "reports read own" on public.photo_reports;
create policy "reports read own" on public.photo_reports
  for select to authenticated using (reporter_profile_id = public.my_profile_id());
