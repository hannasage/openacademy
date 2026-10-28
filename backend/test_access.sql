begin;
-- All test accounts and rows are rolled back at the end.
select email as original_owner from touchline_private.owner_settings \gset
update touchline_private.owner_settings set email='touchline-test-owner@example.invalid';
insert into auth.users(id,email,email_confirmed_at,aud,role)
values('00000000-0000-4000-8000-000000000001','touchline-test-owner@example.invalid',now(),'authenticated','authenticated');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select public.save_learning_course('test-course','{"id":"test-course"}','{"curriculumId":"test-course"}',-1);
do $$begin
 if (select count(*) from public.learning_courses where id='test-course') != 1 then raise exception 'Owner read failed'; end if;
 begin
  perform public.save_learning_course('test-course','{"id":"test-course"}','{"curriculumId":"test-course"}',-1);
  raise exception 'Stale creation was accepted';
 exception when serialization_failure then null;
 end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$begin
 if exists(select 1 from public.learning_courses) then raise exception 'Non-owner read was accepted'; end if;
 begin
  perform public.save_learning_course('test-course','{"id":"test-course"}','{"curriculumId":"test-course"}',0);
  raise exception 'Non-owner write was accepted';
 exception when insufficient_privilege then null;
 end;
end$$;
reset role;
do $$begin
 begin
  insert into auth.users(id,email,aud,role) values('00000000-0000-4000-8000-000000000003','unapproved@example.invalid','authenticated','authenticated');
  raise exception 'Unapproved signup accepted';
 exception when raise_exception then
  if sqlerrm not like 'This is a private learning hub%' then raise; end if;
 end;
end$$;
set local role anon;
do $$begin
 begin
  perform 1 from public.learning_courses;
  raise exception 'Anonymous read accepted';
 exception when insufficient_privilege then null;
 end;
end$$;
reset role;
rollback;
