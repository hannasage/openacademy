# Owner-hosted setup connector

This server installs Touchline into an owner's dedicated Supabase project. Each owner runs their own Vercel deployment, PostgreSQL connector database, and two Supabase OAuth registrations. The connector stores no learning files. The desktop hub keeps editable lessons and journals on the owner's computer.

## Deployment configuration

Apply `schema.sql` to a separate PostgreSQL database with an operator account. The public server never creates its own storage schema. Give its database account access only to `touchline_connector.documents`. Use a verified TLS connection; set `TOUCHLINE_SETUP_DATABASE_CA` if the database uses a private certificate authority.

Run `node backend/setup/cli.mjs initialize-secrets` locally. Transfer its generated values through the deployment's secret settings. Never commit them or add them to a URL. Set these server values:

| Name | Value |
| --- | --- |
| `TOUCHLINE_SETUP_DATABASE_URL` | Dedicated connector PostgreSQL connection URL |
| `TOUCHLINE_SETUP_DATABASE_CA` | Optional trusted certificate chain |
| `TOUCHLINE_SETUP_ENCRYPTION_KEY` | Generated encryption key |
| `TOUCHLINE_SETUP_BOOTSTRAP_KEY` | Generated one-use setup code |
| `TOUCHLINE_SETUP_BOOTSTRAP_EXPIRES_AT` | Generated fixed expiry |
| `TOUCHLINE_SETUP_ORIGIN` | Exact public HTTPS origin, without a path |
| `TOUCHLINE_SETUP_OWNER_EMAIL` | Sole learning owner email |
| `TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_ID` | Discovery OAuth client ID |
| `TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_SECRET` | Discovery OAuth client secret |
| `TOUCHLINE_SUPABASE_INSTALL_CLIENT_ID` | Installation OAuth client ID |
| `TOUCHLINE_SUPABASE_INSTALL_CLIENT_SECRET` | Installation OAuth client secret |

Register two separate apps in the owner's Supabase organization. Configure the discovery app with `projects:read`, `database:read`, and `auth:read`. Configure the installation app with those scopes plus `database:write`, `auth:write`, and `secrets:read`. Use exact callback URLs at the configured origin: `/setup/callback/discovery` and `/setup/callback/install`. Scope selection belongs to each registration; the authorization URL does not request broader permissions. See the [Supabase OAuth guide](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration) and [scope reference](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes).

Open `/setup` and enter the one-use code. This creates a short setup session; it does not sign into the learning app. Reuse after consumption, expiry, logout, or process restart is rejected. To unlock again, run `node backend/setup/cli.mjs rotate-bootstrap`, replace both bootstrap values in the deployment, and redeploy. Keep the encryption key unchanged. Rotation invalidates earlier setup sessions; retired keys cannot be restored to regain access.

## Preparation and recovery

The browser reviews the exact project, owner, hub name, origin, migration hashes, and inspected state before installation. The first prepare request checks that review. Each later request runs one durable step. A stopped step has a one-minute lease; after that lease, status requires fresh inspection and approval. A failed or interrupted write is never blindly retried. Existing data and completed migrations remain in place.

The connector accepts only its shipped database catalogs and known platform grants. Unknown schemas, altered policies, column grants, unrelated Auth accounts, storage objects or buckets, Vault secrets, or database webhook records require manual review. Existing owner configuration must match the configured email; a bound account must be confirmed and active. The connector does not change an existing owner to a new identity.

A completed setup stores only a validated public hub description and safe receipts. It checks published discovery and backend health before reporting completion. It clears temporary credentials before revoking each app grant. Until revocation succeeds, status keeps a manual-revocation warning. Revoke unresolved app permissions in Supabase organization settings before starting a new flow. A crash after credential disposal can require that manual step.

## Expiration cleanup

The owner must schedule `node backend/setup/cli.mjs cleanup` on a trusted operator runner with the same deployment environment. There is no public cleanup endpoint and no automatic scheduler in this package. Run it at least once per minute to process expired setup flows. It consumes at most 100 expired flows per run and reports a count of manual revocations. Exit code 2 means manual revocation remains; exit code 1 means cleanup could not finish. Alert on either code and retry after fixing the cause. A stopped scheduler leaves encrypted credentials in the connector database until cleanup resumes; expired flows cannot use them.

## Learning sign-in callbacks

Email codes are the default learning sign-in. Setup preserves Google and Apple provider configuration and advertises only providers already enabled by the owner. It adds exact callback paths for the hosted origin, the default desktop addresses `http://127.0.0.1:8765` and `http://localhost:8765`, and the native scheme `love.hannasage.touchline://auth/return`. Query nonces use a wildcard after an escaped literal question mark. See [Supabase redirect patterns](https://supabase.com/docs/guides/auth/redirect-urls).

For another desktop port, add that exact local origin's `/auth/return\?touchline-return=*` entry in Supabase Auth. The native entry is `love.hannasage.touchline://auth/return\?attempt=*`. Do not add wildcard hosts or arbitrary callback paths. Email sign-in remains available when a social provider has not been configured.

## Server adapter

`createSetupRuntime(env, {verifyPublished})` returns `{service, admin, store, close}`. The required verifier must read the configured public origin and the reviewed backend health endpoint with bounded requests and no redirects. `admin.unlock(code)` returns a session token and CSRF token; put only the session token in a secure, HTTP-only cookie. `admin.session(token)` restores the server-owned context. POST routes call `admin.authenticate(token, csrfToken)` and enforce the exact Origin before invoking the service. Never construct owner context from JSON.

The service exposes `begin`, `callback`, `projects`, `review`, `authorizeInstall`, `prepare`, `cancel`, and `status`. Status includes a safe `revision`; repeated prepare calls continue only while that revision advances. The public description comes from `readPublicHub(store)`. The store uses atomic compare-and-swap updates, meaning only a request holding the current revision can change a flow.

## Tests

`npm run verify` includes mocked Management API tests and socket-only disposable PostgreSQL tests. The latter use separate connector and learning databases. `generate-catalog.py` rebuilds catalog evidence only in its own disposable cluster, with platform grants from [Supabase's initial schema](https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql). The schema inventory uses a narrow subset of the [Supabase CLI internal schemas](https://pkg.go.dev/github.com/supabase/cli/pkg/migration); unrecognized extensions require manual review.
