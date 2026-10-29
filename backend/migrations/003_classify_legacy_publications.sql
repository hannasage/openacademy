-- Preserve old rows exactly. Only validated rows enter the versioned snapshot view.
begin;
do $$
declare row public.learning_courses;
begin
 for row in select * from public.learning_courses where format_version=0 for update loop
  begin
   perform touchline_private.validate_publication(row.id,row.curriculum,row.progress);
   update public.learning_courses set format_version=1 where user_id=row.user_id and id=row.id;
  exception when invalid_parameter_value then
   -- The original row remains readable through the legacy table, marked 0.
   -- The owner must export and republish it through the validated write path.
   null;
  end;
 end loop;
end;
$$;
commit;
