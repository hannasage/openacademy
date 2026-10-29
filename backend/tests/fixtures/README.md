# Database fixtures

`auth.sql` defines only the Supabase database fields that Touchline reads.
It is a test substitute for the Auth schema, not a Supabase installation.
All users, addresses, and credentials in these tests are synthetic.

The field names match the official [Supabase user model](https://github.com/supabase/auth/blob/master/internal/models/user.go).
The following upstream migrations define the additional authorization fields:

- [Account ban time](https://github.com/supabase/auth/blob/master/migrations/20220114185340_add_banned_until.up.sql).
- [Account deletion time](https://github.com/supabase/auth/blob/master/migrations/20230116124412_add_deleted_at.up.sql).
- [Anonymous-account flag](https://github.com/supabase/auth/blob/master/migrations/20240214120130_add_is_anonymous_column.up.sql).

`legacy-schema.sql` is Touchline's pre-P07 schema.
Upgrade tests apply it only inside their own disposable database.
The fixture preserves the old table grants so tests can prove that migration removes them.

These tests do not simulate email delivery, provider consent, automatic identity linking, or session revocation.
Provider cases assert which account UUID receives database access after a link or account change.
