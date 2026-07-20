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
