-- Minimal Supabase database boundary fixture. This does not run the Auth service.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (
 id uuid primary key, email text, email_confirmed_at timestamptz,
 banned_until timestamptz, is_anonymous boolean not null default false,
 deleted_at timestamptz, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}'
);
create table auth.identities (id text primary key, user_id uuid references auth.users(id), provider text);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id), created_at timestamptz, updated_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function auth.jwt() returns jsonb language sql stable as $$
 select jsonb_build_object('sub',nullif(current_setting('request.jwt.claim.sub',true),''),
 'session_id',nullif(current_setting('request.jwt.claim.session_id',true),''));
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000001','owner@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000002','other@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000003','pending@example.invalid',null);
insert into auth.sessions select ('1'||substr(id::text,2))::uuid,id,now(),now() from auth.users;
