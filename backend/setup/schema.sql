-- Run once through the owner's reviewed connector-database bootstrap process.
-- This schema is separate from learning records and must not be exposed by PostgREST.
begin;
create schema if not exists touchline_connector;
revoke all on schema touchline_connector from public;
create table if not exists touchline_connector.documents (
 id text primary key,
 version bigint not null check(version >= 0),
 body jsonb not null check(jsonb_typeof(body) = 'object'),
 expires_at timestamptz,
 check(body->>'id' = id),
 check((body->>'version')::bigint = version)
);
revoke all on touchline_connector.documents from public;
commit;
