-- The Hourly: follow-up hardening (round 2).
--
-- Apply AFTER supabase-schema.sql, supabase-security-hardening.sql, and
-- supabase-admin.sql, in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Idempotent and safe to re-run.
--
-- Closes two gaps found in the second audit:
--   1. `nudges` could be sent to ANY profile id (not just people you share a
--      group with) — the same class of issue already fixed for notifications.
--      A nudge fires a push, so this was a cross-group push-spam vector.
--   2. Storage uploads to the `photos` bucket were allowed for the anonymous
--      role, so an unauthenticated client could write files into the bucket.
--      Uploads now require sign-in AND may only land in the uploader's own
--      profile folder.

-- ---------------------------------------------------------------------------
-- 1. Nudges: only nudge people you share a group with
-- ---------------------------------------------------------------------------

drop policy if exists "nudges send" on public.nudges;
create policy "nudges send" on public.nudges
  for insert to authenticated with check (
    from_profile_id = public.my_profile_id()
    and exists (
      select 1
      from public.group_members gm_me
      join public.group_members gm_to on gm_to.group_id = gm_me.group_id
      where gm_me.profile_id = public.my_profile_id()
        and gm_to.profile_id = to_profile_id
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Storage: require sign-in to upload, and only into your own folder
--
-- Photo paths are "<profile_id>/<name>.jpg", so the first path segment must
-- equal the uploader's own profile id. This blocks anonymous uploads and
-- blocks writing into someone else's folder.
--
-- If uploads break after this (some projects historically didn't resolve the
-- `authenticated` role for the publishable key), revert to the previous policy
-- by re-running supabase-schema.sql, and tell the audit before retrying.
-- ---------------------------------------------------------------------------

do $$
begin
  drop policy if exists "photo uploads" on storage.objects;
  create policy "photo uploads" on storage.objects
    for insert to authenticated with check (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = public.my_profile_id()::text
    );
exception when others then
  raise notice 'Could not tighten the storage upload policy via SQL (%). Set it in the dashboard: Storage -> photos -> Policies -> INSERT for authenticated only.', sqlerrm;
end $$;
