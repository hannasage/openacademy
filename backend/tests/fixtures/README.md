# Database fixtures

`auth.sql` defines only the Supabase database fields that Schola reads.
It is a test substitute for the Auth schema, not a Supabase installation.
All users, addresses, and credentials in these tests are synthetic.

The field names match the official [Supabase user model](https://github.com/supabase/auth/blob/master/internal/models/user.go).
The following upstream migrations define the additional authorization fields:

- [Account ban time](https://github.com/supabase/auth/blob/master/migrations/20220114185340_add_banned_until.up.sql).
- [Account deletion time](https://github.com/supabase/auth/blob/master/migrations/20230116124412_add_deleted_at.up.sql).
- [Anonymous-account flag](https://github.com/supabase/auth/blob/master/migrations/20240214120130_add_is_anonymous_column.up.sql).

`legacy-schema.sql` is Schola's pre-P07 schema.
Upgrade tests apply it only inside their own disposable database.
The fixture preserves the old table grants so tests can prove that migration removes them.

The session fixture matches the [Auth session migration](https://github.com/supabase/auth/blob/master/migrations/20220811173540_add_sessions_table.up.sql).
It supplies session claims so tests can prove that missing and revoked sessions cannot read or write learning records.
These tests do not run email delivery, provider consent, automatic identity linking, or the live Auth service.
Provider cases assert which account UUID receives database access after a link or account change.
