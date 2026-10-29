-- Check the live Auth session on every learning read and write.
begin;
create table if not exists touchline_private.session_registry (
 session_id uuid primary key,
 account_id uuid not null references auth.users(id),
 label text check(label is null or (length(label) between 1 and 80 and label=btrim(label) and label!~'[[:cntrl:]]')),
 last_seen_at timestamptz,
 revoked_at timestamptz
);
alter table touchline_private.session_registry enable row level security;
revoke all on touchline_private.session_registry from public, anon, authenticated;

create or replace function touchline_private.current_session_id() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare claim text := auth.jwt()->>'session_id';
begin
 if claim is null or claim !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return null; end if;
 return claim::uuid;
end;
$$;
revoke all on function touchline_private.current_session_id() from public, anon, authenticated;

-- Kept mandatory by migration 001 on every later replay, including a replay
-- interrupted before this migration. Never remove this helper in a rollback.
create or replace function touchline_private.session_is_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.sessions s
  where s.id=touchline_private.current_session_id() and s.user_id=auth.uid()
   and not exists(select 1 from touchline_private.session_registry r where r.session_id=s.id and r.revoked_at is not null));
$$;
revoke all on function touchline_private.session_is_allowed() from public, anon, authenticated;

create or replace function touchline_private.is_owner() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists (
  select 1 from touchline_private.owner_settings o join auth.users u on u.id=o.owner_user_id
  where u.id=auth.uid() and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
   and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
   and touchline_private.session_is_allowed()
 );
$$;
revoke all on function touchline_private.is_owner() from public, anon;
grant execute on function touchline_private.is_owner() to authenticated;

create or replace function touchline_private.require_owner() returns uuid
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from touchline_private.owner_settings where singleton for share;
 -- Serialize revocation with publication, then recheck the session after waiting.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
 if not touchline_private.is_owner() then
  raise exception 'This deployment is private or the session has ended.' using errcode='42501';
 end if;
 return auth.uid();
end;
$$;
revoke all on function touchline_private.require_owner() from public, anon, authenticated;

create or replace function public.register_touchline_session(device_label text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := touchline_private.require_owner(); sid uuid := touchline_private.current_session_id();
begin
 if device_label is null or length(btrim(device_label)) not between 1 and 80 or device_label~'[[:cntrl:]]' then
  raise exception 'Enter a device label of 1 to 80 characters.' using errcode='22023';
 end if;
 insert into touchline_private.session_registry(session_id,account_id,label,last_seen_at)
 values(sid,owner_id,btrim(device_label),now())
 on conflict(session_id) do update set label=excluded.label,last_seen_at=excluded.last_seen_at
 where session_registry.account_id=owner_id and session_registry.revoked_at is null;
 if not found then raise exception 'The session has ended.' using errcode='42501'; end if;
 return jsonb_build_object('sessionId',sid,'accountId',owner_id);
end;
$$;

create or replace function public.list_touchline_sessions() returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := touchline_private.require_owner(); result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('sessionId',s.id,'label',coalesce(r.label,'Unknown device'),
  'createdAt',s.created_at,'lastSeenAt',r.last_seen_at,'isCurrent',s.id=touchline_private.current_session_id())
  order by s.created_at desc nulls last,s.id),'[]'::jsonb) into result
 from auth.sessions s left join touchline_private.session_registry r on r.session_id=s.id
 where s.user_id=owner_id and r.revoked_at is null;
 return result;
end;
$$;

create or replace function public.revoke_touchline_session(target_session_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := touchline_private.require_owner();
begin
 if not exists(select 1 from auth.sessions where id=target_session_id and user_id=owner_id) then
  raise exception 'This account does not have that live session.' using errcode='22023';
 end if;
 insert into touchline_private.session_registry(session_id,account_id,revoked_at)
 values(target_session_id,owner_id,now())
 on conflict(session_id) do update set revoked_at=coalesce(session_registry.revoked_at,excluded.revoked_at)
 where session_registry.account_id=owner_id;
 if not found then raise exception 'This account cannot revoke that session.' using errcode='42501'; end if;
 return true;
end;
$$;
revoke all on function public.register_touchline_session(text), public.list_touchline_sessions(), public.revoke_touchline_session(uuid) from public, anon, authenticated;
grant execute on function public.register_touchline_session(text), public.list_touchline_sessions(), public.revoke_touchline_session(uuid) to authenticated;
commit;
