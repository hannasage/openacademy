# Private publications

Schola keeps editable learning records on the local computer.
An owner publishes copies to their own Supabase project.
Each deployment admits one owner account and stores that account's published curricula.

## Install or upgrade

Use a dedicated Supabase project with PostgreSQL 15 or later.
The admission trigger applies to the project's entire Auth user table.
Keep email confirmation enabled and configure production email delivery in Supabase.
The [Supabase self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) covers a self-hosted deployment.

Review the numbered migrations before applying them to a live deployment.
Apply them in filename order through the Supabase SQL Editor.
Alternatively, `schema.sql` is a `psql` entry point that includes those files.
Each migration runs in a transaction and can run again without replacing existing records.

The migrations perform these steps:

1. Restrict writes, add owner identity, and install publication and library functions.
2. Pin an existing owner when exactly one confirmed account matches the configured admission email.
3. Mark compatible legacy publications as version 1 snapshots.
4. Require a live, permitted account session for every learning request.

Configure the admission email through a privileged database connection:

```sql
select touchline_private.configure_owner('you@example.com');
```

If no matching account exists, the first account with that email receives the owner UUID.
A UUID is an account's stable identifier.
That account receives no learning access until its email is confirmed.
Once the UUID is pinned, new account creation is denied, including another account with the same email.

The setup script applies the migrations and then configures the owner.
It reads `POSTGRES_URL` from the project's private `.env.local` file without printing credentials.
Run it only after the deployment migration review:

```sh
python3 backend/apply.py --owner-email you@example.com
```

If owner configuration fails, the completed schema stays installed and existing records remain intact.
Correct the owner input, then run the command again.
An empty or unresolved owner setting denies learning access.
A duplicate matching account requires an explicit owner UUID and never selects an account arbitrarily.

## Owner identity and provider accounts

Learning access requires the pinned UUID, a confirmed email, and an active, nonanonymous Auth account.
Email addresses and user-editable profile fields do not grant access after the UUID is pinned.
Changing an email or linking Google or Apple to the same account does not change its owner UUID.
A separate provider account, including an Apple relay-address account, receives no access.

A privileged operator can select an existing confirmed account explicitly:

```sql
select touchline_private.configure_owner('you@example.com', 'CONFIRMED-OWNER-UUID');
```

The setup script exposes the same recovery operation through `--owner-id`.
It validates and pins that account after migration 001, before migration 002
tries to bind an existing owner by email. This lets the same command recover
from an ambiguous legacy email without weakening account validation.
The database rejects an unconfirmed, banned, deleted, or anonymous recovery target.
Changing the pin does not transfer or delete old publications.
Review the old account's data before changing ownership.
Re-running configuration without `--owner-id` keeps an existing pin unchanged.

## Publication writes

Authenticated clients can read their own rows through row-level security.
They cannot insert, update, or delete either public table directly.
The write functions run with database privileges after checking the caller's pinned account.
They reject unknown fields, unsupported versions, invalid references, and publications of 2 MB or more.
Private draft fields and local extension fields cannot enter new publications.

`save_learning_course(course_id, course_content, course_progress, expected_revision)` remains available to the current clients.
It publishes an active curriculum and returns the saved row.
Use `-1` to create a course and its current remote revision to replace it.
A stale revision returns SQLSTATE `40001` without replacing the row.
Invalid input returns `22023`; private-access rejection returns `42501`.
The local progress revision stays separate from the remote publication revision.

New clients use these interfaces:

| Interface | Result |
| --- | --- |
| `publish_learning_course(course_id, course_content, course_progress, course_status, expected_revision, request_id)` | Saved course row with `status` and `format_version` |
| `save_learning_library(library, expected_revision, request_id)` | P02 published-library version 1 |
| `learning_snapshots` | `user_id`, `id`, and P02 published-course version 1 in `snapshot` |
| `learning_library_snapshots` | `user_id` and P02 published-library version 1 in `snapshot` |

`request_id` is optional.
If a connection fails after a write, repeat the identical request with the same UUID.
The function returns its original receipt without another write.
Reusing that UUID for different content or another operation fails.
Without a request UUID, a repeated write with an old revision returns a conflict.
Receipts stay private in the database and contain no session credentials.

A library write supplies `version`, `revision`, and `focusCurriculumId`.
Its revision equals the expected revision, or zero for a new library.
Focus can reference only an active published curriculum.
Pausing, completing, or saving that curriculum for later clears its focus in the same transaction.
Other active curricula stay active.

## Legacy records and recovery

Migration keeps each old curriculum, progress document, revision, and timestamp unchanged.
Compatible rows appear in the versioned snapshot view.
An incompatible row retains `format_version = 0` and stays out of that view.
The owner can still read it through `learning_courses` for export and repair.
Republish repaired content through the validated write function to create a version 1 snapshot.
No migration deletes a malformed publication or guesses missing content.

Rollback uses a reviewed forward repair.
Do not restore direct table grants to recover from a client error.
The legacy publishing function remains available throughout this upgrade.
If a migration fails, inspect its error and retry after repair.
A failed owner-binding migration leaves the write restrictions installed and denies access until an owner is resolved.

## Disposable database tests

Install PostgreSQL with `initdb`, `pg_ctl`, and `psql`.
From the project directory, run:

```sh
npm run test:backend
```

The runner finds common macOS and Linux installations.
Set `PG_BIN` to the directory containing all three binaries if discovery fails.
It creates a temporary cluster with a private Unix socket and no TCP listener.
It ignores inherited PostgreSQL connection variables and uses an empty password file.
It reads no deployment environment file and accepts no database URL.
The runner stops its server and removes only its own temporary directory when tests finish.

The tests cover direct-write denial, private reads, owner recovery, provider-account identity, conflicting writes, retry receipts, invalid content, library focus, and upgrades.
They also verify concurrent requests against the real PostgreSQL engine.
The fixture supplies the Supabase `auth.users` boundary and `auth.uid()` function.
It does not run Supabase Auth, provider consent, email delivery, or token revocation.
Those service flows require the later account integration tests.
`test_access.sql` refuses execution and points to this disposable runner.

## Device sessions

Migration 004 checks the token's session ID against `auth.sessions` and a private revocation record.
The [Supabase session guide](https://supabase.com/docs/guides/auth/sessions) describes this check for tokens that remain valid after sign-out.
A missing, foreign, or revoked session cannot read or write learning records.
Session revocation does not delete publications.
It also blocks later tokens issued for the same session ID.
An offline device can still hold an earlier downloaded copy until it reconnects and learns that access ended.

The authenticated owner can call these functions:

| Function | Result |
| --- | --- |
| `register_touchline_session(device_label)` | Current `sessionId` and `accountId` after permission checks |
| `list_touchline_sessions()` | Session IDs, labels, creation times, last observed times, and the current-session flag |
| `revoke_touchline_session(target_session_id)` | `true` after revocation of an owned session |

Registration labels only the current session and records that request's time.
Unregistered sessions appear as “Unknown device” with no last observed time.
The list does not claim that a device is online.
Registration cannot restore a revoked session.
The functions expose no tokens and require no administrative key in the client.

Review this migration before applying it to a live project.
Older clients with valid Supabase sessions retain access through their existing account checks.
Tokens without a live session ID lose access.
Rollback uses a forward repair that preserves the private revocation records.
Once session checks exist, migration 001 keeps them mandatory on every replay.
An interrupted replay cannot restore access to a revoked session.
Keep the private session helper and registry in every forward repair.
