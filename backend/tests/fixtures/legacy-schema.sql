begin;
create schema if not exists touchline_private;
revoke all on schema touchline_private from public, anon;
grant usage on schema touchline_private to authenticated;
create table if not exists touchline_private.owner_settings (
  singleton boolean primary key default true check (singleton),
  email text not null unique check (email = lower(email))
);
alter table touchline_private.owner_settings enable row level security;
revoke all on touchline_private.owner_settings from public, anon, authenticated;

-- Only a verified account whose current email matches the operator's setting is an owner.
create or replace function touchline_private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from auth.users u
    join touchline_private.owner_settings s on lower(u.email) = s.email
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;
revoke all on function touchline_private.is_owner() from public, anon;
grant execute on function touchline_private.is_owner() to authenticated;

-- A database trigger rejects account creation for all other addresses.
create or replace function touchline_private.restrict_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or not exists (
    select 1 from touchline_private.owner_settings where email = lower(new.email)
  ) then
    raise exception 'This is a private learning hub. Account creation is restricted.';
  end if;
  return new;
end;
$$;
revoke all on function touchline_private.restrict_signup() from public, anon, authenticated;
drop trigger if exists touchline_restrict_signup on auth.users;
create trigger touchline_restrict_signup before insert on auth.users
for each row execute function touchline_private.restrict_signup();

create table if not exists public.learning_courses (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  curriculum jsonb not null check (jsonb_typeof(curriculum) = 'object' and curriculum->>'id' = id),
  progress jsonb not null check (jsonb_typeof(progress) = 'object' and progress->>'curriculumId' = id),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  primary key(user_id, id),
  check (octet_length(curriculum::text) + octet_length(progress::text) < 2000000)
);
alter table public.learning_courses enable row level security;
revoke all on public.learning_courses from public, anon, authenticated;
grant select, insert, update on public.learning_courses to authenticated;
drop policy if exists owner_read on public.learning_courses;
create policy owner_read on public.learning_courses for select to authenticated
using (user_id = (select auth.uid()) and (select touchline_private.is_owner()));
drop policy if exists owner_insert on public.learning_courses;
create policy owner_insert on public.learning_courses for insert to authenticated
with check (user_id = (select auth.uid()) and (select touchline_private.is_owner()));
drop policy if exists owner_update on public.learning_courses;
create policy owner_update on public.learning_courses for update to authenticated
using (user_id = (select auth.uid()) and (select touchline_private.is_owner()))
with check (user_id = (select auth.uid()) and (select touchline_private.is_owner()));

create or replace function public.save_learning_course(
  course_id text, course_content jsonb, course_progress jsonb, expected_revision integer
) returns public.learning_courses
language plpgsql security invoker set search_path = '' as $$
declare
  result public.learning_courses;
begin
  if auth.uid() is null or not touchline_private.is_owner() then
    raise exception 'This deployment is private.' using errcode = '42501';
  end if;
  if expected_revision = -1 then
    insert into public.learning_courses(user_id,id,curriculum,progress)
    values(auth.uid(),course_id,course_content,course_progress)
    on conflict do nothing returning * into result;
    if result.id is null then
      raise exception 'Newer cloud progress exists. Download it before uploading.' using errcode = '40001';
    end if;
  else
    update public.learning_courses
    set curriculum=course_content, progress=course_progress, revision=revision+1, updated_at=now()
    where user_id=auth.uid() and id=course_id and revision=expected_revision
    returning * into result;
    if result.id is null then
      raise exception 'Newer cloud progress exists. Download it before uploading.' using errcode = '40001';
    end if;
  end if;
  return result;
end;
$$;
revoke all on function public.save_learning_course(text,jsonb,jsonb,integer) from public, anon;
grant execute on function public.save_learning_course(text,jsonb,jsonb,integer) to authenticated;
commit;
