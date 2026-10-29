-- Forward-only, repeatable migration. Keep all existing rows and legacy RPC calls.
begin;
create schema if not exists touchline_private;
revoke all on schema touchline_private from public, anon;
grant usage on schema touchline_private to authenticated;
create table if not exists touchline_private.owner_settings (
 singleton boolean primary key default true check(singleton),
 email text not null unique check(email=lower(email))
);
alter table touchline_private.owner_settings add column if not exists owner_user_id uuid references auth.users(id);
alter table touchline_private.owner_settings enable row level security;
revoke all on touchline_private.owner_settings from public, anon, authenticated;

create or replace function touchline_private.is_owner() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists (
  select 1 from touchline_private.owner_settings s join auth.users u on u.id=s.owner_user_id
  where u.id=auth.uid() and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
 );
$$;
revoke all on function touchline_private.is_owner() from public, anon;
grant execute on function touchline_private.is_owner() to authenticated;

create or replace function touchline_private.require_owner() returns uuid
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from touchline_private.owner_settings where singleton for share;
 if not touchline_private.is_owner() then
  raise exception 'This deployment is private.' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
 return auth.uid();
end;
$$;

-- Administrative only. Email admits the first account; a pinned UUID controls access.
create or replace function touchline_private.configure_owner(owner_email text, owner_account_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare chosen uuid; matches integer; current_owner uuid;
begin
 if owner_email is null or owner_email<>lower(btrim(owner_email)) or owner_email!~'^[^[:space:]@]+@[^[:space:]@]+$' then
  raise exception 'Enter a lowercase owner email.' using errcode='22023';
 end if;
 select owner_user_id into current_owner from touchline_private.owner_settings where singleton for update;
 if owner_account_id is not null then
  select id into chosen from auth.users where id=owner_account_id and email_confirmed_at is not null
   and not coalesce(is_anonymous,false) and deleted_at is null and (banned_until is null or banned_until<=now());
  if chosen is null then raise exception 'Select an existing confirmed owner account.' using errcode='22023'; end if;
 elsif current_owner is not null then
  chosen:=current_owner;
 else
  select count(*), (array_agg(id))[1] into matches,chosen from auth.users where lower(email)=owner_email and deleted_at is null;
  if matches>1 then raise exception 'Several accounts match. Configure an explicit owner UUID.' using errcode='22023'; end if;
  if chosen is not null and not exists(select 1 from auth.users where id=chosen and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then
   raise exception 'Confirm the existing owner account before configuration.' using errcode='22023';
  end if;
 end if;
 insert into touchline_private.owner_settings(singleton,email,owner_user_id) values(true,owner_email,chosen)
 on conflict(singleton) do update set email=excluded.email,owner_user_id=excluded.owner_user_id;
 return chosen;
end;
$$;

create or replace function touchline_private.restrict_signup() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings touchline_private.owner_settings;
begin
 select * into settings from touchline_private.owner_settings where singleton for update;
 if not found or settings.owner_user_id is not null or new.email is null or lower(new.email)<>settings.email
   or coalesce(new.is_anonymous,false) then
  raise exception 'This is a private learning hub. Account creation is restricted.' using errcode='42501';
 end if;
 -- AFTER INSERT allows the owner UUID foreign key to resolve. The transaction
 -- rolls back the account as well if admission or pinning fails.
 update touchline_private.owner_settings set owner_user_id=new.id where singleton;
 return new;
end;
$$;
drop trigger if exists touchline_restrict_signup on auth.users;
create trigger touchline_restrict_signup after insert on auth.users for each row execute function touchline_private.restrict_signup();

create or replace function touchline_private.object_fields(v jsonb, required text[], optional text[] default '{}') returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(v) is distinct from 'object' or not (v ?& required)
  or exists(select 1 from jsonb_object_keys(v) k where not(k=any(required||optional))) then
  raise exception 'Invalid object fields.' using errcode='22023';
 end if;
end;
$$;
create or replace function touchline_private.text_value(v jsonb, maximum integer default null, nonblank boolean default false) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(v) is distinct from 'string' or (maximum is not null and length(v#>>'{}')>maximum)
  or (nonblank and (v#>>'{}')!~'[^[:space:]]') then
  raise exception 'Invalid text field.' using errcode='22023';
 end if;
end;
$$;
create or replace function touchline_private.number_value(v jsonb, minimum numeric, maximum numeric, integral boolean default false) returns void
language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if jsonb_typeof(v) is distinct from 'number' then raise exception 'Invalid numeric field.' using errcode='22023'; end if;
 n:=(v#>>'{}')::numeric;
 if n<minimum or n>maximum or (integral and trunc(n)<>n) then raise exception 'Number is outside its allowed range.' using errcode='22023'; end if;
end;
$$;
create or replace function touchline_private.text_array(v jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare item jsonb;
begin
 if jsonb_typeof(v) is distinct from 'array' then raise exception 'Expected a text list.' using errcode='22023'; end if;
 for item in select * from jsonb_array_elements(v) loop perform touchline_private.text_value(item); end loop;
end;
$$;
create or replace function touchline_private.validate_publication(course_id text, c jsonb, p jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare m jsonb; r jsonb; e jsonb; field text; ref text; key text; item jsonb; course_module jsonb; ids text[]:='{}';
begin
 if course_id is null or course_id!~'^[a-z0-9][a-z0-9-]{0,59}$' then raise exception 'Invalid curriculum ID.' using errcode='22023'; end if;
 if octet_length(c::text)+octet_length(p::text)>=2000000 then raise exception 'Publication must be smaller than 2 MB.' using errcode='22023'; end if;
 perform touchline_private.object_fields(c,array['id','title','subtitle','description','weeks','weeklyHours','resources','modules'],array['version','nextPhase','researchDate','totalHours']);
 perform touchline_private.text_value(c->'id');
 if c->>'id'<>course_id or (c?'version' and c->'version'<>'1'::jsonb) then raise exception 'Unsupported curriculum identity or version.' using errcode='22023'; end if;
 foreach field in array array['title','subtitle','description'] loop perform touchline_private.text_value(c->field,null,true); end loop;
 perform touchline_private.number_value(c->'weeks',1,520,true);
 perform touchline_private.number_value(c->'weeklyHours',1,40);
 if c?'totalHours' then perform touchline_private.number_value(c->'totalHours',0,20800); end if;
 if c?'researchDate' then perform touchline_private.text_value(c->'researchDate'); end if;
 if c?'nextPhase' then perform touchline_private.text_array(c->'nextPhase'); end if;
 if jsonb_typeof(c->'resources') is distinct from 'object' then raise exception 'Expected resources.' using errcode='22023'; end if;
 for r in select value from jsonb_each(c->'resources') loop
  perform touchline_private.object_fields(r,array['title','url','use']);
  foreach field in array array['title','url','use'] loop perform touchline_private.text_value(r->field); end loop;
  if r->>'url'!~'^https?://[^[:space:]]+$' then raise exception 'Resources need HTTP or HTTPS URLs.' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(c->'modules') is distinct from 'array' or jsonb_array_length(c->'modules') not between 1 and 100 then raise exception 'Expected 1 to 100 modules.' using errcode='22023'; end if;
 for m in select * from jsonb_array_elements(c->'modules') loop
  perform touchline_private.object_fields(m,array['id','title','phase','question','outcome','math','evidence','challenge','reading','dataset','tasks','weeks','resources','prerequisites','hours','weekStart','weekEnd'],array['number']);
  perform touchline_private.text_value(m->'id');
  if m->>'id'!~'^[a-zA-Z0-9_-]{1,60}$' or m->>'id'=any(ids) then raise exception 'Invalid or duplicate module ID.' using errcode='22023'; end if;
  ids:=array_append(ids,m->>'id');
  foreach field in array array['title','phase','question','outcome','math','evidence','challenge','reading','dataset'] loop perform touchline_private.text_value(m->field); end loop;
  foreach field in array array['tasks','weeks','resources','prerequisites'] loop perform touchline_private.text_array(m->field); end loop;
  if jsonb_array_length(m->'tasks') not between 1 and 30 then raise exception 'Expected 1 to 30 tasks.' using errcode='22023'; end if;
  foreach field in array array['hours','weekStart','weekEnd'] loop
   perform touchline_private.number_value(m->field,0,10000);
   if (m->>field)::numeric=0 then raise exception 'Module numbers must be positive.' using errcode='22023'; end if;
  end loop;
  if m?'number' then perform touchline_private.number_value(m->'number',1,9007199254740991,true); end if;
  if (m->>'weekStart')::numeric>(m->>'weekEnd')::numeric or (m->>'weekEnd')::numeric>(c->>'weeks')::numeric then raise exception 'Module weeks exceed the curriculum.' using errcode='22023'; end if;
  for ref in select jsonb_array_elements_text(m->'resources') loop
   if not(c->'resources'?ref) then raise exception 'Unknown resource.' using errcode='22023'; end if;
  end loop;
 end loop;
 for m in select * from jsonb_array_elements(c->'modules') loop
  for ref in select jsonb_array_elements_text(m->'prerequisites') loop
   if not(ref=any(ids)) then raise exception 'Unknown prerequisite.' using errcode='22023'; end if;
  end loop;
 end loop;
 perform touchline_private.object_fields(p,array['version','revision','curriculumId','weeklyHours','startDate','modules','experiments']);
 perform touchline_private.text_value(p->'curriculumId');
 if p->'version'<>'1'::jsonb or p->>'curriculumId'<>course_id then raise exception 'Unsupported progress identity or version.' using errcode='22023'; end if;
 perform touchline_private.number_value(p->'revision',0,9007199254740991,true);
 perform touchline_private.number_value(p->'weeklyHours',1,40);
 perform touchline_private.text_value(p->'startDate',10);
 if p->>'startDate'<>'' then
  if p->>'startDate'!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid start date.' using errcode='22023'; end if;
  begin perform (p->>'startDate')::date; exception when others then raise exception 'Invalid start date.' using errcode='22023'; end;
 end if;
 if jsonb_typeof(p->'modules') is distinct from 'object' then raise exception 'Invalid module progress.' using errcode='22023'; end if;
 for key,m in select * from jsonb_each(p->'modules') loop
  if not(key=any(ids)) then raise exception 'Unknown progress module.' using errcode='22023'; end if;
  select value into course_module from jsonb_array_elements(c->'modules') where value->>'id'=key;
  perform touchline_private.object_fields(m,array['status','tasks','notes','evidence','hours']);
  perform touchline_private.text_value(m->'status');
  if m->>'status' not in ('not-started','active','complete') then raise exception 'Invalid progress status.' using errcode='22023'; end if;
  if jsonb_typeof(m->'tasks') is distinct from 'array' or jsonb_array_length(m->'tasks')<>jsonb_array_length(course_module->'tasks') then raise exception 'Invalid task count.' using errcode='22023'; end if;
  for item in select * from jsonb_array_elements(m->'tasks') loop
   if jsonb_typeof(item) is distinct from 'boolean' then raise exception 'Task values must be boolean.' using errcode='22023'; end if;
   if m->>'status'='complete' and item<>'true'::jsonb then raise exception 'Finish every task before completion.' using errcode='22023'; end if;
  end loop;
  perform touchline_private.text_value(m->'notes',50000);
  perform touchline_private.text_value(m->'evidence',50000,m->>'status'='complete');
  perform touchline_private.number_value(m->'hours',0,10000);
 end loop;
 if jsonb_typeof(p->'experiments') is distinct from 'array' or jsonb_array_length(p->'experiments')>2000 then raise exception 'Invalid experiment list.' using errcode='22023'; end if;
 for e in select * from jsonb_array_elements(p->'experiments') loop
  perform touchline_private.object_fields(e,array['id','date','module','title','hypothesis','result']);
  foreach field in array array['id','date','module','title','hypothesis','result'] loop perform touchline_private.text_value(e->field,20000,field='title'); end loop;
  if not(e->>'module'=any(ids)) then raise exception 'Unknown experiment module.' using errcode='22023'; end if;
 end loop;
end;
$$;

create table if not exists public.learning_courses (
 user_id uuid not null references auth.users(id) on delete cascade,
 id text not null check(id~'^[a-z0-9][a-z0-9-]{0,59}$'),
 curriculum jsonb not null, progress jsonb not null,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 updated_at timestamptz not null default now(), primary key(user_id,id),
 check(octet_length(curriculum::text)+octet_length(progress::text)<2000000)
);
do $$begin
 if (select data_type from information_schema.columns where table_schema='public' and table_name='learning_courses' and column_name='revision')<>'bigint' then
  alter table public.learning_courses alter column revision type bigint;
 end if;
end$$;
alter table public.learning_courses add column if not exists status text not null default 'active' check(status in ('active','paused','completed','saved'));
alter table public.learning_courses add column if not exists format_version integer not null default 0 check(format_version in (0,1));
alter table public.learning_courses enable row level security;
revoke all on public.learning_courses from public,anon,authenticated;
grant select on public.learning_courses to authenticated;
drop policy if exists owner_read on public.learning_courses;
drop policy if exists owner_insert on public.learning_courses;
drop policy if exists owner_update on public.learning_courses;
create policy owner_read on public.learning_courses for select to authenticated using(user_id=(select auth.uid()) and (select touchline_private.is_owner()));
drop policy if exists touchline_private_read_guard on public.learning_courses;
create policy touchline_private_read_guard on public.learning_courses as restrictive for select to authenticated using(user_id=(select auth.uid()) and (select touchline_private.is_owner()));

create table if not exists public.learning_libraries (
 user_id uuid primary key references auth.users(id) on delete cascade,
 version integer not null default 1 check(version=1),
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 focus_curriculum_id text,
 foreign key(user_id,focus_curriculum_id) references public.learning_courses(user_id,id)
);
alter table public.learning_libraries enable row level security;
revoke all on public.learning_libraries from public,anon,authenticated;
grant select on public.learning_libraries to authenticated;
drop policy if exists owner_read on public.learning_libraries;
create policy owner_read on public.learning_libraries for select to authenticated using(user_id=(select auth.uid()) and (select touchline_private.is_owner()));
drop policy if exists touchline_private_read_guard on public.learning_libraries;
create policy touchline_private_read_guard on public.learning_libraries as restrictive for select to authenticated using(user_id=(select auth.uid()) and (select touchline_private.is_owner()));
create table if not exists touchline_private.write_requests (
 user_id uuid not null references auth.users(id) on delete cascade, request_id uuid not null,
 operation text not null, payload jsonb not null, result jsonb not null,
 primary key(user_id,request_id)
);
alter table touchline_private.write_requests enable row level security;
revoke all on touchline_private.write_requests from public,anon,authenticated;

create or replace function public.publish_learning_course(course_id text,course_content jsonb,course_progress jsonb,course_status text,expected_revision bigint,request_id uuid default null) returns public.learning_courses
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; result public.learning_courses; old_request touchline_private.write_requests; request_payload jsonb;
begin
 owner_id:=touchline_private.require_owner();
 perform touchline_private.validate_publication(course_id,course_content,course_progress);
 if expected_revision is null or expected_revision not between -1 and 9007199254740990 or course_status is null or course_status not in ('active','paused','completed','saved') then raise exception 'Invalid revision or curriculum status.' using errcode='22023'; end if;
 request_payload:=jsonb_build_object('id',course_id,'curriculum',course_content,'progress',course_progress,'status',course_status,'expectedRevision',expected_revision);
 if request_id is not null then
  select * into old_request from touchline_private.write_requests where user_id=owner_id and write_requests.request_id=publish_learning_course.request_id;
  if found then
   if old_request.operation<>'course' or old_request.payload<>request_payload then raise exception 'A retry ID cannot identify a different request.' using errcode='22023'; end if;
   select * into result from jsonb_populate_record(null::public.learning_courses,old_request.result); return result;
  end if;
 end if;
 if expected_revision=-1 then
  insert into public.learning_courses(user_id,id,curriculum,progress,status,format_version) values(owner_id,course_id,course_content,course_progress,course_status,1)
  on conflict do nothing returning * into result;
 else
  update public.learning_courses set curriculum=course_content,progress=course_progress,status=course_status,format_version=1,revision=revision+1,updated_at=clock_timestamp()
  where user_id=owner_id and id=course_id and revision=expected_revision returning * into result;
 end if;
 if result.id is null then raise exception 'Newer cloud progress exists. Download it before uploading.' using errcode='40001'; end if;
 if course_status<>'active' then
  update public.learning_libraries set focus_curriculum_id=null,revision=revision+1 where user_id=owner_id and focus_curriculum_id=course_id;
 end if;
 if request_id is not null then
  insert into touchline_private.write_requests values(owner_id,request_id,'course',request_payload,to_jsonb(result));
 end if;
 return result;
end;
$$;

create or replace function public.save_learning_course(course_id text,course_content jsonb,course_progress jsonb,expected_revision integer) returns public.learning_courses
language sql security definer set search_path='' as $$
 select public.publish_learning_course(course_id,course_content,course_progress,'active',expected_revision::bigint,null);
$$;

create or replace function public.save_learning_library(library jsonb,expected_revision bigint,request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; focus text; result public.learning_libraries; response jsonb; old_request touchline_private.write_requests; request_payload jsonb;
begin
 owner_id:=touchline_private.require_owner();
 perform touchline_private.object_fields(library,array['version','revision','focusCurriculumId']);
 if library->'version'<>'1'::jsonb then raise exception 'Unsupported library version.' using errcode='22023'; end if;
 perform touchline_private.number_value(library->'revision',0,9007199254740991,true);
 if expected_revision is null or expected_revision not between -1 and 9007199254740990 or (library->>'revision')::bigint<>greatest(expected_revision,0) then raise exception 'Invalid library revision.' using errcode='22023'; end if;
 if library->'focusCurriculumId'<>'null'::jsonb then perform touchline_private.text_value(library->'focusCurriculumId'); end if;
 focus:=library->>'focusCurriculumId';
 request_payload:=jsonb_build_object('library',library,'expectedRevision',expected_revision);
 if request_id is not null then
  select * into old_request from touchline_private.write_requests where user_id=owner_id and write_requests.request_id=save_learning_library.request_id;
  if found then
   if old_request.operation<>'library' or old_request.payload<>request_payload then raise exception 'A retry ID cannot identify a different request.' using errcode='22023'; end if;
   return old_request.result;
  end if;
 end if;
 if focus is not null and not exists(select 1 from public.learning_courses where user_id=owner_id and id=focus and status='active') then raise exception 'Focus must reference an active published curriculum.' using errcode='22023'; end if;
 if expected_revision=-1 then
  insert into public.learning_libraries(user_id,focus_curriculum_id) values(owner_id,focus) on conflict do nothing returning * into result;
 else
  update public.learning_libraries set focus_curriculum_id=focus,revision=revision+1 where user_id=owner_id and revision=expected_revision returning * into result;
 end if;
 if result.user_id is null then raise exception 'Newer library changes exist. Refresh before publishing.' using errcode='40001'; end if;
 response:=jsonb_build_object('version',1,'revision',result.revision,'focusCurriculumId',result.focus_curriculum_id);
 if request_id is not null then insert into touchline_private.write_requests values(owner_id,request_id,'library',request_payload,response); end if;
 return response;
end;
$$;

-- Views emit the P02 contracts while the original table shape remains readable.
create or replace view public.learning_snapshots with(security_invoker=true) as
 select user_id,id,jsonb_build_object('format','touchline-snapshot','version',format_version,
  'curriculum',curriculum,'progress',progress,'status',status,'revision',revision,
  'publishedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as snapshot
 from public.learning_courses where format_version=1;
create or replace view public.learning_library_snapshots with(security_invoker=true) as
 select user_id,jsonb_build_object('version',version,'revision',revision,'focusCurriculumId',focus_curriculum_id) as snapshot from public.learning_libraries;
revoke all on public.learning_snapshots,public.learning_library_snapshots from public,anon,authenticated;
grant select on public.learning_snapshots,public.learning_library_snapshots to authenticated;

-- Table-level REVOKE does not remove old column-level grants.
do $$
declare target text; columns text;
begin
 foreach target in array array['public.learning_courses','public.learning_libraries','touchline_private.owner_settings','touchline_private.write_requests','public.learning_snapshots','public.learning_library_snapshots'] loop
  select string_agg(quote_ident(attname),',') into columns from pg_attribute where attrelid=target::regclass and attnum>0 and not attisdropped;
  execute format('revoke all privileges (%s) on %s from public,anon,authenticated',columns,target);
 end loop;
end;
$$;

-- Every helper is private; only the owner predicate is callable for RLS.
revoke all on all functions in schema touchline_private from public,anon,authenticated;
grant execute on function touchline_private.is_owner() to authenticated;
revoke all on function public.save_learning_course(text,jsonb,jsonb,integer) from public,anon;
revoke all on function public.publish_learning_course(text,jsonb,jsonb,text,bigint,uuid) from public,anon;
revoke all on function public.save_learning_library(jsonb,bigint,uuid) from public,anon;
grant execute on function public.save_learning_course(text,jsonb,jsonb,integer),public.publish_learning_course(text,jsonb,jsonb,text,bigint,uuid),public.save_learning_library(jsonb,bigint,uuid) to authenticated;
commit;
