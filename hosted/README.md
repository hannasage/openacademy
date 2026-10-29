# Public hub and account routes

`createPublicHandler` serves a version 1 hub description at `/.well-known/touchline.json`.
The owner supplies the description and the deployed application's HTML when the host starts.
The handler accepts only public fields from `contracts/hub-description.v1.schema.json`.
It rejects an administrative key or any extra field before serving requests.

The description includes the hub identity, HTTPS origins, publishable key, supported formats, and enabled account providers.
It contains no user account, access token, refresh token, database password, or setup permission.
Its CORS response allows browsers to discover it without sending credentials.
The browser rejects redirects, different identities, unsupported versions, and responses larger than 32 KiB.

`/auth/return` serves the application shell with no caching or referrer forwarding.
The handler never inserts the return query into HTML and never redirects to a user-supplied address.
The application removes return parameters from browser history before processing them.
It accepts a provider code only for an unexpired, unused transaction from that browser tab and the selected hub.
The Supabase client then exchanges the code with its stored PKCE verifier.
PKCE binds an authorization code to the browser that requested it.

The local Python server serves the same application shell at `/auth/return`.
Hosting adapters and guided project preparation follow in the deployment step.
The handler does not create resources, register provider apps, or apply migrations.

## Owner configuration

Apply reviewed backend migrations through the separately approved database process.
Keep email confirmation enabled.
Configure Supabase's email template to send `{{ .Token }}` rather than a magic link.
Configure the desired code expiry and delivery limits in Supabase Auth.
Touchline also prevents another code request for one minute in the current page.
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
The session list names sessions observed by Touchline and labels others as unknown devices.
A last-checked time records a successful Touchline request, not proof that a device is online.
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
