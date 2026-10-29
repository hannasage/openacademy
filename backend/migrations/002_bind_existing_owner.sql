-- Bind a prior verified owner without changing their content or chosen email.
begin;
do $$
declare settings touchline_private.owner_settings; matches integer; chosen uuid;
begin
 select * into settings from touchline_private.owner_settings where singleton for update;
 if found and settings.owner_user_id is null then
  select count(*),(array_agg(id))[1] into matches,chosen from auth.users
  where lower(email)=settings.email and email_confirmed_at is not null and deleted_at is null and not coalesce(is_anonymous,false);
  if matches>1 then raise exception 'Several verified accounts match. Configure an explicit owner UUID.'; end if;
  if matches=1 then update touchline_private.owner_settings set owner_user_id=chosen where singleton; end if;
 end if;
end;
$$;
commit;
