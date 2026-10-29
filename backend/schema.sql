-- psql entry point. In the Supabase SQL Editor, apply the numbered files in order.
\ir migrations/001_private_writes.sql
\ir migrations/002_bind_existing_owner.sql
\ir migrations/003_classify_legacy_publications.sql
\ir migrations/004_session_access.sql
