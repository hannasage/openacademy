# Your private backend

Touchline uses Supabase Auth and Postgres. Each deployment belongs to one owner.
The application code uses the MIT license. External datasets and readings retain their own licenses.
Other people deploy their own Supabase project and enter its connection details in their apps.
They do not connect to your backend.

## Set up a deployment

Create a dedicated Supabase project through your account or run your own Supabase installation.
Do not apply this schema to a shared application database.
The signup trigger restricts account creation across its entire Supabase project.

Use the official self-hosting guide for a self-hosted installation:
https://supabase.com/docs/guides/self-hosting/docker

Keep email confirmation enabled in Supabase Auth.
Use a supported SMTP configuration for production email delivery.

Apply `schema.sql` through the Supabase SQL Editor.
Set the only allowed owner email with this statement:

```sql
insert into touchline_private.owner_settings(singleton, email)
values (true, lower('you@example.com'))
on conflict(singleton) do update set email = excluded.email;
```

Alternatively, place the project connection string in `POSTGRES_URL` inside `.env.local`.
Run the setup script from the project root:

```sh
python3 backend/apply.py --owner-email you@example.com
```

The setup script needs `psql` on your PATH.
It reads database credentials from `.env.local` without printing them.

## Connect the desktop hub

Open the Devices tab in the running local application.
Enter the Supabase project URL and publishable key.
Select Connect backend.
Create the owner account with the configured email and a password.
Open the confirmation email.
Return to the Devices tab and sign in.
Select Publish current course.

Export the connection file for the native app.
The connection file contains the project URL and publishable key, not an administrative secret.
Never enter a secret key or service-role key into either application.

## Connect the native app

Import the connection file into Touchline on your iPhone or iPad.
Sign in with the same owner account.
Refresh published courses.
The application stores downloaded lessons and progress for offline reading.
The native companion is read-only in this version.

## Access controls

The database rejects signup attempts for every email except the configured owner email.
Database access also requires a confirmed email and the current owner account.
Row-level security limits each record to its authenticated owner.
The application does not trust user-editable profile metadata for authorization.
Anonymous clients receive no table access.
Conflicting uploads fail instead of silently replacing a newer revision.

The private project still exposes public authentication endpoints.
Access rules prevent unauthorized records, but they do not eliminate all traffic or abuse costs.
Use Supabase rate limits and usage monitoring for your deployment.
Do not publish administrative keys or `.env.local`.

## Test the access rules

The SQL test runs inside a transaction and rolls back its temporary accounts and records.
Run it only against the dedicated Touchline project.
From the project root, run:

```sh
python3 -c 'from pathlib import Path; from backend.apply import psql; psql(Path("backend/test_access.sql").read_text()); print("Access tests passed.")'
```

The test covers owner access, anonymous denial, non-owner denial, restricted signup, and stale-write rejection.
