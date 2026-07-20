-- The Hourly: admin role, admin-wide access, and report alerting.
--
-- Apply this AFTER supabase-schema.sql AND supabase-security-hardening.sql,
-- in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Idempotent and safe to re-run.
--
-- This gives a designated admin (the app owner) the ability to see every
-- photo, comment, reaction, group, and report across the whole app, and to
-- delete any photo. It also wires new reports to an Edge Function that pushes
-- and emails the admin.

-- ---------------------------------------------------------------------------
-- 1. Admin flag
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Designate the owner. Change/extend the email(s) here to add admins.
update public.profiles set is_admin = true where lower(email) = 'akram.aboukhalil@gmail.com';

-- True when the current session belongs to an admin. SECURITY DEFINER so it can
-- read the flag regardless of the caller's own row-level permissions.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where auth_id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- 2. Admin-wide read access + delete-any-photo
--
-- Each policy below is the hardened definition from supabase-security-
-- hardening.sql / supabase-schema.sql with "or public.is_admin()" added, so an
-- admin can see and moderate everything while normal users are unchanged.
-- ---------------------------------------------------------------------------

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  for select to authenticated using (public.can_view_profile(id) or public.is_admin());

drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos
  for select to authenticated using (public.can_view_photo(id) or public.is_admin());

drop policy if exists "photos delete own" on public.photos;
create policy "photos delete own" on public.photos
  for delete to authenticated using (profile_id = public.my_profile_id() or public.is_admin());

drop policy if exists "photo_groups read" on public.photo_groups;
create policy "photo_groups read" on public.photo_groups
  for select to authenticated using (
    public.is_group_member(group_id)
    or exists (select 1 from public.photos ph where ph.id = photo_id and ph.profile_id = public.my_profile_id())
    or public.is_admin()
  );

drop policy if exists "groups read" on public.groups;
create policy "groups read" on public.groups
  for select to authenticated using (public.is_group_member(id) or public.is_admin());

drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments
  for select to authenticated using (public.can_view_photo(photo_id) or public.is_admin());

drop policy if exists "reactions read" on public.reactions;
create policy "reactions read" on public.reactions
  for select to authenticated using (public.can_view_photo(photo_id) or public.is_admin());

-- Admin can read and update (set status on) every report; a normal user still
-- only sees their own.
drop policy if exists "reports read own" on public.photo_reports;
create policy "reports read own" on public.photo_reports
  for select to authenticated using (reporter_profile_id = public.my_profile_id() or public.is_admin());

drop policy if exists "reports update own" on public.photo_reports;
create policy "reports update own" on public.photo_reports
  for update to authenticated
  using (reporter_profile_id = public.my_profile_id() or public.is_admin())
  with check (reporter_profile_id = public.my_profile_id() or public.is_admin());

-- Admin can delete any photo's storage file, not just files they own.
do $$
begin
  drop policy if exists "photo delete own" on storage.objects;
  create policy "photo delete own" on storage.objects
    for delete to authenticated using (
      bucket_id = 'photos' and (owner = auth.uid() or public.is_admin())
    );
exception when others then
  raise notice 'Could not update the storage delete policy via SQL (%). Update it in the dashboard: Storage -> photos -> Policies.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Report alerting: push + email the admin when a report is filed
--
-- Mirrors notify_send_push: pg_net fires an async HTTP POST to the
-- `report-alert` Edge Function (deploy supabase/functions/report-alert), which
-- re-fetches the report server-side and notifies every admin.
-- ---------------------------------------------------------------------------

create or replace function public.notify_report_alert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://hnuznphuqpencmrtfrzv.supabase.co/functions/v1/report-alert',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('record', jsonb_build_object('id', NEW.id))
  );
  return NEW;
end;
$$;

drop trigger if exists photo_reports_alert on public.photo_reports;
create trigger photo_reports_alert
  after insert on public.photo_reports
  for each row execute function public.notify_report_alert();
