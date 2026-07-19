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

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  taken_at timestamptz not null default now(),
  image_path text not null,
  metadata jsonb,
  firebase_id text unique,
  created_at timestamptz not null default now()
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

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.photos enable row level security;
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

drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos
  for select to authenticated using (true);

drop policy if exists "photos insert" on public.photos;
create policy "photos insert" on public.photos
  for insert to authenticated
  with check (
    profile_id = public.my_profile_id()
    or (firebase_id is not null and exists (
      select 1 from public.profiles p where p.id = profile_id and p.auth_id is null
    )) -- the Firebase import writes other members' old photos to unclaimed placeholders
  );

drop policy if exists "photos delete own" on public.photos;
create policy "photos delete own" on public.photos
  for delete to authenticated using (profile_id = public.my_profile_id());

drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments
  for select to authenticated using (true);

drop policy if exists "comments insert" on public.comments;
create policy "comments insert" on public.comments
  for insert to authenticated
  with check (
    profile_id = public.my_profile_id()
    or exists (select 1 from public.photos ph where ph.id = photo_id and ph.firebase_id is not null)
  );

drop policy if exists "comments delete own" on public.comments;
create policy "comments delete own" on public.comments
  for delete to authenticated using (profile_id = public.my_profile_id());

drop policy if exists "reactions read" on public.reactions;
create policy "reactions read" on public.reactions
  for select to authenticated using (true);

drop policy if exists "reactions insert" on public.reactions;
create policy "reactions insert" on public.reactions
  for insert to authenticated
  with check (
    profile_id = public.my_profile_id()
    or exists (select 1 from public.photos ph where ph.id = photo_id and ph.firebase_id is not null)
  );

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
  create policy "photo uploads" on storage.objects
    for insert to authenticated with check (bucket_id = 'photos');

  drop policy if exists "photo delete own" on storage.objects;
  create policy "photo delete own" on storage.objects
    for delete to authenticated using (bucket_id = 'photos' and owner = auth.uid());
exception when others then
  raise notice 'Could not create storage policies via SQL (%). In the dashboard: Storage -> photos bucket -> Policies -> New policy -> allow INSERT for authenticated users.', sqlerrm;
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
