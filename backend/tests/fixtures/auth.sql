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
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000001','owner@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000002','other@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000003','pending@example.invalid',null);
