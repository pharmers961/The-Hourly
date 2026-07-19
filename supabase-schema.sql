-- The Hourly: Supabase schema, security policies, storage, and realtime.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: statements are idempotent where possible.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique references auth.users(id) on delete set null,
  email text unique not null,
  name text not null default 'Unknown',
  timezone text not null default 'UTC',
  last_active timestamptz,
  settings jsonb not null default '{}'::jsonb,
  firebase_uid text unique,
  created_at timestamptz not null default now()
);

-- A private circle (e.g. "Family", "Friends"). Photos are shared into one or
-- more groups; members only ever see groups they belong to.
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) <= 60),
  invite_code text unique not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, profile_id)
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  taken_at timestamptz not null default now(),
  image_path text not null,
  metadata jsonb,
  firebase_id text unique,
  created_at timestamptz not null default now()
);

-- Which group(s) a photo has been shared into. A photo is captured once and
-- can be shared into any number of groups the uploader belongs to.
create table if not exists public.photo_groups (
  photo_id uuid not null references public.photos(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (photo_id, group_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.photos(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(text) <= 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.reactions (
  photo_id uuid not null references public.photos(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 8),
  created_at timestamptz not null default now(),
  primary key (photo_id, profile_id, emoji)
);

create table if not exists public.nudges (
  id uuid primary key default gen_random_uuid(),
  from_profile_id uuid not null references public.profiles(id) on delete cascade,
  to_profile_id uuid not null references public.profiles(id) on delete cascade,
  hour_key text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  to_profile_id uuid not null references public.profiles(id) on delete cascade,
  from_name text not null check (char_length(from_name) <= 50),
  photo_id uuid references public.photos(id) on delete cascade,
  text text check (char_length(text) <= 1000),
  type text not null check (type in ('comment', 'mention')),
  created_at timestamptz not null default now()
);

create index if not exists photos_taken_at_idx on public.photos (taken_at desc);
create index if not exists comments_photo_idx on public.comments (photo_id);
create index if not exists nudges_to_idx on public.nudges (to_profile_id);
create index if not exists notifications_to_idx on public.notifications (to_profile_id);
create index if not exists group_members_profile_idx on public.group_members (profile_id);
create index if not exists photo_groups_group_idx on public.photo_groups (group_id);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- The signed-in user's profile id (profiles are linked to auth accounts
-- via auth_id; migrated placeholder profiles have auth_id null until claimed).
create or replace function public.my_profile_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.profiles where auth_id = auth.uid()
$$;

-- Called after every sign-in: returns the caller's profile, claiming a
-- migrated placeholder (matched by email) or creating a fresh one.
create or replace function public.ensure_profile(p_name text default null, p_timezone text default null)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_profile public.profiles;
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'not authenticated';
  end if;

  select * into v_profile from profiles where auth_id = auth.uid();
  if found then
    update profiles
      set last_active = now(),
          timezone = coalesce(nullif(p_timezone, ''), timezone),
          name = coalesce(nullif(p_name, ''), name)
      where id = v_profile.id
      returning * into v_profile;
    return v_profile;
  end if;

  -- Claim a placeholder created by the Firebase import
  select * into v_profile from profiles where lower(email) = v_email and auth_id is null;
  if found then
    update profiles
      set auth_id = auth.uid(),
          last_active = now(),
          timezone = coalesce(nullif(p_timezone, ''), timezone),
          name = coalesce(nullif(p_name, ''), name)
      where id = v_profile.id
      returning * into v_profile;
    return v_profile;
  end if;

  insert into profiles (auth_id, email, name, timezone, last_active)
  values (
    auth.uid(),
    v_email,
    -- "akram.aboukhalil@..." -> "Akram Aboukhalil"
    coalesce(nullif(p_name, ''), initcap(btrim(translate(split_part(v_email, '@', 1), '._-', '   ')))),
    coalesce(nullif(p_timezone, ''), 'UTC'),
    now()
  )
  returning * into v_profile;
  return v_profile;
end;
$$;

create or replace function public.generate_invite_code()
returns text
language sql volatile
as $$
  select translate(encode(gen_random_bytes(9), 'base64'), '+/=', 'xyz')
$$;

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and profile_id = public.my_profile_id()
  )
$$;

-- A photo is visible to its uploader, or to anyone in a group it's been
-- shared into.
create or replace function public.can_view_photo(p_photo_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.photos ph
    where ph.id = p_photo_id and ph.profile_id = public.my_profile_id()
  ) or exists (
    select 1 from public.photo_groups pg
    where pg.photo_id = p_photo_id and public.is_group_member(pg.group_id)
  )
$$;

-- Creates a new group and makes the caller its owner, atomically.
create or replace function public.create_group(p_name text)
returns public.groups
language plpgsql security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_profile_id uuid := public.my_profile_id();
begin
  if v_profile_id is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'group name required';
  end if;

  insert into groups (name, invite_code, created_by)
  values (btrim(p_name), public.generate_invite_code(), v_profile_id)
  returning * into v_group;

  insert into group_members (group_id, profile_id, role)
  values (v_group.id, v_profile_id, 'owner');

  return v_group;
end;
$$;

-- Joins the caller to the group matching an invite code. Auto-joins with no
-- approval step; safe to call again (no-op if already a member).
create or replace function public.join_group_by_code(p_code text)
returns public.groups
language plpgsql security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_profile_id uuid := public.my_profile_id();
begin
  if v_profile_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_group from groups where invite_code = btrim(p_code);
  if not found then
    raise exception 'That invite link is invalid or has expired.';
  end if;

  insert into group_members (group_id, profile_id, role)
  values (v_group.id, v_profile_id, 'member')
  on conflict (group_id, profile_id) do nothing;

  return v_group;
end;
$$;

-- Any member (everyone is an admin) can invalidate the old invite link and
-- get a fresh code.
create or replace function public.regenerate_invite_code(p_group_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Only group members can do this.';
  end if;

  v_code := public.generate_invite_code();
  update groups set invite_code = v_code where id = p_group_id;
  return v_code;
end;
$$;

-- Creator-only: hand the creator role to another member (the caller becomes a
-- regular member). Used when the creator wants to leave without deleting the
-- group.
create or replace function public.transfer_ownership(p_group_id uuid, p_new_owner uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := public.my_profile_id();
begin
  if not exists (
    select 1 from group_members
    where group_id = p_group_id and profile_id = v_me and role = 'owner'
  ) then
    raise exception 'Only the group creator can transfer the creator role.';
  end if;
  if not exists (
    select 1 from group_members where group_id = p_group_id and profile_id = p_new_owner
  ) then
    raise exception 'That person is not a member of this group.';
  end if;

  update group_members set role = 'member' where group_id = p_group_id and profile_id = v_me;
  update group_members set role = 'owner' where group_id = p_group_id and profile_id = p_new_owner;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.photos enable row level security;
alter table public.photo_groups enable row level security;
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.nudges enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles insert" on public.profiles;
create policy "profiles insert" on public.profiles
  for insert to authenticated
  with check (auth_id = auth.uid() or auth_id is null); -- placeholders from the Firebase import

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated
  using (auth_id = auth.uid() or auth_id is null); -- unclaimed placeholders may be corrected by the Firebase import

drop policy if exists "profiles delete own" on public.profiles;
create policy "profiles delete own" on public.profiles
  for delete to authenticated using (auth_id = auth.uid());

-- Groups: creation/joining always goes through the security-definer RPCs
-- above, so there are no direct insert policies here.
drop policy if exists "groups read" on public.groups;
create policy "groups read" on public.groups
  for select to authenticated using (public.is_group_member(id));

-- Every member is an admin (rename, invite, remove members), EXCEPT deleting
-- the whole group, which is reserved for the creator (role = 'owner').
drop policy if exists "groups update owner" on public.groups;
drop policy if exists "groups update member" on public.groups;
create policy "groups update member" on public.groups
  for update to authenticated using (public.is_group_member(id));

drop policy if exists "groups delete member" on public.groups;
drop policy if exists "groups delete owner" on public.groups;
create policy "groups delete owner" on public.groups
  for delete to authenticated using (
    exists (select 1 from group_members gm where gm.group_id = id and gm.profile_id = public.my_profile_id() and gm.role = 'owner')
  );

drop policy if exists "group_members read" on public.group_members;
create policy "group_members read" on public.group_members
  for select to authenticated using (public.is_group_member(group_id));

drop policy if exists "group_members delete" on public.group_members;
create policy "group_members delete" on public.group_members
  for delete to authenticated using (
    -- leave yourself (any role), or (as an admin) remove any non-creator member;
    -- the creator's row can't be kicked by others — they must transfer or delete
    profile_id = public.my_profile_id()
    or (role <> 'owner' and public.is_group_member(group_id))
  );

drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos
  for select to authenticated using (public.can_view_photo(id));

drop policy if exists "photos insert" on public.photos;
create policy "photos insert" on public.photos
  for insert to authenticated
  with check (profile_id = public.my_profile_id());

drop policy if exists "photos delete own" on public.photos;
create policy "photos delete own" on public.photos
  for delete to authenticated using (profile_id = public.my_profile_id());

drop policy if exists "photo_groups read" on public.photo_groups;
create policy "photo_groups read" on public.photo_groups
  for select to authenticated using (
    public.is_group_member(group_id)
    or exists (select 1 from photos ph where ph.id = photo_id and ph.profile_id = public.my_profile_id())
  );

drop policy if exists "photo_groups insert" on public.photo_groups;
create policy "photo_groups insert" on public.photo_groups
  for insert to authenticated with check (
    public.is_group_member(group_id)
    and exists (select 1 from photos ph where ph.id = photo_id and ph.profile_id = public.my_profile_id())
  );

drop policy if exists "photo_groups delete" on public.photo_groups;
create policy "photo_groups delete" on public.photo_groups
  for delete to authenticated using (
    exists (select 1 from photos ph where ph.id = photo_id and ph.profile_id = public.my_profile_id())
  );

drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments
  for select to authenticated using (public.can_view_photo(photo_id));

drop policy if exists "comments insert" on public.comments;
create policy "comments insert" on public.comments
  for insert to authenticated
  with check (profile_id = public.my_profile_id() and public.can_view_photo(photo_id));

drop policy if exists "comments delete own" on public.comments;
create policy "comments delete own" on public.comments
  for delete to authenticated using (profile_id = public.my_profile_id());

drop policy if exists "reactions read" on public.reactions;
create policy "reactions read" on public.reactions
  for select to authenticated using (public.can_view_photo(photo_id));

drop policy if exists "reactions insert" on public.reactions;
create policy "reactions insert" on public.reactions
  for insert to authenticated
  with check (profile_id = public.my_profile_id() and public.can_view_photo(photo_id));

drop policy if exists "reactions delete own" on public.reactions;
create policy "reactions delete own" on public.reactions
  for delete to authenticated using (profile_id = public.my_profile_id());

drop policy if exists "nudges send" on public.nudges;
create policy "nudges send" on public.nudges
  for insert to authenticated with check (from_profile_id = public.my_profile_id());

drop policy if exists "nudges read own" on public.nudges;
create policy "nudges read own" on public.nudges
  for select to authenticated using (to_profile_id = public.my_profile_id());

drop policy if exists "nudges delete own" on public.nudges;
create policy "nudges delete own" on public.nudges
  for delete to authenticated using (to_profile_id = public.my_profile_id());

drop policy if exists "notifications send" on public.notifications;
create policy "notifications send" on public.notifications
  for insert to authenticated with check (true);

drop policy if exists "notifications read own" on public.notifications;
create policy "notifications read own" on public.notifications
  for select to authenticated using (to_profile_id = public.my_profile_id());

drop policy if exists "notifications delete own" on public.notifications;
create policy "notifications delete own" on public.notifications
  for delete to authenticated using (to_profile_id = public.my_profile_id());

-- ---------------------------------------------------------------------------
-- Migrate pre-groups data into a single "Sibs and Sigs" group so nothing
-- already shared disappears. Uses a fixed id so it's safe to re-run.
--
-- The group + its creator are only set up once (first branch below), but
-- the membership/photo backfill runs on EVERY execution, not just the
-- first. That matters because people and photos keep getting added over
-- time (a family member signing in for the first time and claiming their
-- placeholder profile, an extra Firebase import, ordinary captures made
-- before this script's most recent run) — without an always-on backfill,
-- anyone/anything added after the very first run would silently never
-- join the group. Note: if someone has deliberately used "Leave Group" on
-- this specific group, re-running this script will add them back — that's
-- an accepted tradeoff for this migration helper.
-- ---------------------------------------------------------------------------

do $$
declare
  v_group_id uuid := '11111111-1111-1111-1111-111111111111';
  v_owner_id uuid;
begin
  if not exists (select 1 from groups where id = v_group_id) then
    select id into v_owner_id from profiles where lower(email) = 'akram.aboukhalil@gmail.com' limit 1;
    if v_owner_id is null then
      select id into v_owner_id from profiles order by created_at asc limit 1;
    end if;

    if v_owner_id is not null then
      insert into groups (id, name, invite_code, created_by)
      values (v_group_id, 'Sibs and Sigs', generate_invite_code(), v_owner_id);

      insert into group_members (group_id, profile_id, role)
      values (v_group_id, v_owner_id, 'owner');
    end if;
  end if;

  if exists (select 1 from groups where id = v_group_id) then
    insert into group_members (group_id, profile_id, role)
    select v_group_id, id, 'member' from profiles
    on conflict (group_id, profile_id) do nothing;

    insert into photo_groups (photo_id, group_id)
    select id, v_group_id from photos
    on conflict (photo_id, group_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: photo files
-- ---------------------------------------------------------------------------

-- Some Supabase projects don't allow the SQL editor to touch storage
-- objects/policies (ownership restriction). Wrap in exception handlers so a
-- storage failure never blocks the rest of this script; the fallback is
-- creating the bucket and policies in the dashboard's Storage section.

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('photos', 'photos', true)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Could not create the storage bucket via SQL (%). Create a PUBLIC bucket named "photos" in the dashboard: Storage -> New bucket.', sqlerrm;
end $$;

do $$
begin
  drop policy if exists "photo uploads" on storage.objects;
  drop policy if exists "photo uploads v2" on storage.objects;
  drop policy if exists "photos upload 1io9m69_0" on storage.objects;

  -- Note: this project's Storage service does not reliably recognize the
  -- 'authenticated' role for the anon/publishable API key (see project
  -- history) so uploads are allowed for both roles. Real access control
  -- lives on the `photos`/`photo_groups` tables above: an orphan file in
  -- storage with no visible database row is never shown by the app.
  create policy "photo uploads" on storage.objects
    for insert to authenticated, anon with check (bucket_id = 'photos');

  drop policy if exists "photo delete own" on storage.objects;
  create policy "photo delete own" on storage.objects
    for delete to authenticated using (bucket_id = 'photos' and owner = auth.uid());
exception when others then
  raise notice 'Could not create storage policies via SQL (%). In the dashboard: Storage -> photos bucket -> Policies -> New policy -> allow INSERT for authenticated + anon users.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.photos;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.comments;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.reactions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.nudges;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.groups;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.group_members;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.photo_groups;
exception when duplicate_object then null;
end $$;
