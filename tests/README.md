# Browser checks

Install the project dependencies and Playwright Chromium from the Schola directory:

```sh
npm ci
npx playwright install chromium
```

Run the isolated browser suite:

```sh
npm run test:browser
```

The runner starts its own Python server on an operating-system-assigned port.
It creates a temporary data directory and removes only that directory after the run.
It does not connect to the running hub on port 8765.

Learning requests use real local persistence.
The suite saves a note, restarts the server, imports another curriculum, and checks that their records stay separate.
It also rejects a stale write and confirms that the newer record remains unchanged.
The suite restores unfinished experiments, edit targets, and selected lessons after a server restart.
Failed saves block course changes, and conflicting recovery copies remain available for export.
Separate accounts can download the same curriculum without replacing each other's records.
The tests cover sign-out, canceled imports, version 1 restores, and version 2 restores.

The browser receives an empty `/api/cloud-config` response.
The runner blocks requests to every external origin and tests that restriction.
The suite does not read deployment credentials or send requests to a private backend.
Set `PLAYWRIGHT_EXECUTABLE_PATH` only when using an existing Chromium executable.

Run the isolated-server lifecycle check separately:

```sh
node --test tests/browser/server.test.mjs
```

## Appearance checks

Run the appearance suite on its own isolated server:

```sh
npm run test:appearance
```

This runner also creates temporary storage, suppresses cloud configuration, and blocks external requests and sockets.
It replaces all learning writes with test responses.
Screenshots stay in the temporary directory and leave with that directory after the run.

The suite covers both theme pairs, Dark, Light, and System modes, live system changes, reload, and browser-tab updates.
It also covers draft preservation, dismissal, focus return, narrow layouts, and unavailable storage.
It does not prove durable saving because it replaces write requests.
Use the isolated browser suite for that proof.

For a separately managed disposable server, `tests/appearance.mjs` also accepts `TOUCHLINE_URL` and `TOUCHLINE_ARTIFACT_DIR`.
Its default screenshot directory is `artifacts/`.
`PLAYWRIGHT_MODULE` selects Playwright's module, and `PLAYWRIGHT_EXECUTABLE_PATH` selects Chromium.

## Native checks

Build the native app for an iOS simulator before testing appearance.
Check pair selection, mode selection, device appearance changes, dismissal, and preference persistence after relaunch.
Appearance preferences remain local to each device.

## Data and account checks

`npm test` runs the Python storage tests and Node tests.
Both runtimes read the shared examples in `tests/fixtures/contracts/`.
The examples cover valid records, old backups, unknown versions, invalid references, and private fields in public data.

Account transfer tests replace the Supabase client with an in-memory stub.
They cover canceled downloads, interrupted publication, and account changes while a request waits.
They make no network requests and use no deployment credentials.
