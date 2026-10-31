# Owner-hosted connector

Each owner runs this connector in their own Vercel project with their own PostgreSQL database.
The hosted build contains setup screens and public discovery routes.
It does not contain the local learning editor, curricula, progress files, or account session storage.

## Configure your deployment

1. Import your own repository into Vercel. Keep it private during review. The public Deploy Button template remains unavailable until publication is approved.
2. Create a PostgreSQL database and apply `backend/setup/schema.sql` with an owner-controlled database tool. The connector verifies the database certificate; do not disable verification.
3. Create separate Supabase OAuth registrations for discovery and installation, using the scope lists in `backend/setup/README.md`. Register the exact HTTPS callbacks `/setup/callback/discovery` and `/setup/callback/install` on your chosen hub origin. Provider permission is separate from learning account sign-in.
4. Run `node backend/setup/cli.mjs initialize-secrets` locally. Transfer its generated values to your deployment's secret settings. Never commit them or paste them into an issue or chat. Enter the one-time setup code only at your verified HTTPS connector address; encryption keys, database credentials, and provider secrets never belong in the setup page.
5. Set the environment values below in your Vercel project. Run the repository checks, then deploy through your own Vercel account. The tracked `vercel.json` uses `node hosted/build.mjs`.
6. Open `https://your-hub/setup`, enter the one-time setup code, select a project, and review the changes. Installation needs separate permission and an explicit Prepare action.
7. When setup reports ready, enter the hub address in your local Schola app and sign in by email. Google and Apple appear only when the owner enables them in their backend.

| Environment value | Purpose |
|---|---|
| `TOUCHLINE_SETUP_ORIGIN` | Exact HTTPS hub origin, without a path or trailing slash |
| `TOUCHLINE_SETUP_OWNER_EMAIL` | The only learning owner email for this installation |
| `TOUCHLINE_SETUP_DATABASE_URL` | Owner-supplied PostgreSQL connection URL |
| `TOUCHLINE_SETUP_DATABASE_CA` | Optional trusted certificate authority for the PostgreSQL connection |
| `TOUCHLINE_SETUP_ENCRYPTION_KEY` | Generated 32-byte encryption key; preserve it when rotating the setup code |
| `TOUCHLINE_SETUP_BOOTSTRAP_KEY` | Generated one-use setup code |
| `TOUCHLINE_SETUP_BOOTSTRAP_EXPIRES_AT` | Fixed expiry generated with the setup code |
| `TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_ID` | Discovery app registration ID |
| `TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_SECRET` | Discovery app registration secret |
| `TOUCHLINE_SUPABASE_INSTALL_CLIENT_ID` | Installation app registration ID |
| `TOUCHLINE_SUPABASE_INSTALL_CLIENT_SECRET` | Installation app registration secret |

Use `node backend/setup/cli.mjs rotate-bootstrap` to generate a new setup code after expiry, logout, or a lost browser session.
Update the corresponding deployment values and redeploy; reusing an already consumed code does not restore access.

## Expired permission

Run `node backend/setup/cli.mjs cleanup` from an owner-controlled environment with the connector's deployment configuration.
Schedule that command with your own operator tooling to clean expired setup state even when nobody opens the connector.
Deploying the connector alone does not create a cleanup schedule.
The command revokes expired permission where possible and removes stored token material; review any reported revocation failure in Supabase.

## Build and test

`npm ci` installs the pinned dependencies.
`npm run verify`, `npm run test:browser`, and `npm run test:appearance` run the existing app gates.
`node tests/run-setup-browser.mjs` checks the standalone setup flow with local fixtures and blocked external requests.
`node hosted/build.mjs` creates a new `.vercel/output` deployment tree and refuses to overwrite an existing one.
Use a fresh checkout or a new build output directory for a second build; do not reuse a directory that may contain old public files.

The public files are only the setup bundle, its stylesheet, the two licensed fonts, and their licenses.
The server function contains the setup service, shipped migration SQL, compatibility catalog, and fixed public/setup route handlers.
All other requests return not found, including local data and editor routes.

The hosted account return page clears query and fragment values and tells the user to return to their original app.
It cannot complete a sign-in started on a local app or a native device.
It never reads, exchanges, forwards, or stores return credentials.

## Manual connection

Use the existing migration and owner setup guide in `backend/README.md` when guided preparation is unsuitable.
A hub must publish a valid `/.well-known/touchline.json` description before an app can connect by its address.
Keep learning locally until the destination is ready.

## Font source

The two fonts and their licenses match reviewed appearance commit `5bcc50964e306d02063691c702c199fe8143488c` byte for byte.
They are served locally; the setup pages do not fetch fonts from another service.

## Public discovery

The public hub description follows `contracts/hub-description.v1.schema.json`.
It contains only the hub identity, HTTPS origins, publishable key, supported formats, and enabled account providers.
It contains no user account, session token, database password, or setup permission.
Its CORS response allows discovery without sending credentials.
The browser rejects redirects, unsupported versions, and descriptions larger than 32 KiB.

## Owner configuration

Apply reviewed backend migrations through the separately approved database process.
Keep email confirmation enabled.
Configure Supabase's email template to send `{{ .Token }}` rather than a magic link.
Configure the desired code expiry and delivery limits in Supabase Auth.
Schola also prevents another code request for one minute in the current page.
The server enforces expiry and rate limits across browsers.

List Google or Apple in the public description only after that provider is enabled in the owner's Supabase project.
Add the application's `/auth/return` address to the Supabase redirect allowlist, including its `touchline-return` transaction query.
For the local desktop server, use its actual loopback port.
Do not register arbitrary redirect destinations.
Use the same verified owner account when linking a provider.
A different account receives no learning access even when its provider sign-in succeeds.

The backend admits the configured owner email for first account creation.
It pins the account ID and checks that identity after every offered sign-in method.
Supabase and Vercel setup authorization never acts as account sign-in.
Each owner supplies their own configuration and hosts their own service.

## Sessions and recovery

Every private operation checks a verified account token and registers its live Supabase session through the backend.
The session list names sessions observed by Schola and labels others as unknown devices.
A last-checked time records a successful Schola request, not proof that a device is online.
Revoking a session blocks the next private database request, including requests with an unexpired access token.
Signing out this browser uses Supabase's local scope and hides its private learning records.
A failed sign-out leaves a retry action visible.
An offline device clears its private copies when it next learns that its session ended.

Earlier manual connection details remain in browser storage.
The new flow asks for a hub address and never reassigns older learning files to a discovered hub identity.
A discovery failure leaves local learning available.
Remove or disable the connection screen to roll back the interface without rewriting learning records.
Keep the session migration's restrictions in place until an approved forward repair replaces them.

## Verification

Run `npm run verify`, `npm run test:backend`, and `npm run test:browser`.
Database tests use a disposable PostgreSQL cluster.
Browser tests intercept Auth and database endpoints and block all other external requests.
They do not send email or open a live provider account.
A deployment needs separate email-delivery and configured-provider checks before release.

The implementation follows the Supabase documentation for [email codes](https://supabase.com/docs/guides/auth/auth-email-passwordless), [session identity](https://supabase.com/docs/guides/auth/sessions), and [sign-out scope](https://supabase.com/docs/reference/javascript/auth-signout).

## Deployment return

`hosted/deploy-template.mjs` declares the repository, required environment names, and owner-hosted return path.
Its publication gate is closed. No secret default or shared Sage callback is configured.
After publication review, the template may send a deployment return to the owner's HTTPS `/setup/deployment-return` route.

The return page accepts Vercel's `deployment-url` as an untrusted hint and clears all return parameters from browser history.
It ignores project names, dashboard links, repository links, deployment hooks, and any claimed readiness.
The returned origin must exactly match the connector's configured origin before a check can run.
A different generated Vercel domain requires the owner to open their configured connector address manually.
The owner unlocks setup, inspects the actual stored hub identity, and confirms it before fresh discovery and backend health checks.
A changed hub description invalidates that confirmation. No account is signed in or connected by this return.

The callback fields follow [Vercel's callback documentation](https://vercel.com/docs/deploy-button/callback).
The build tree follows [Vercel's Build Output API](https://vercel.com/docs/build-output-api/primitives).
