# Touchline contracts

These JSON Schemas use JSON Schema draft 2020-12. Their `urn:touchline:contract:*` identifiers identify schemas; they are not network addresses. Load all `*.schema.json` files before compiling a schema with Ajv2020. Validation must not coerce values, add defaults, or remove fields.

| Schema | Purpose |
| --- | --- |
| `curriculum.v1` | Existing curriculum, including supported legacy extensions |
| `progress.v1` | Existing progress, with a local revision |
| `legacy-backup.v1` | Existing curriculum and progress export, with or without its format marker |
| `local-record.v2` | One local record, its origin, status, selected module, and unfinished experiment |
| `library.v1` | One library revision and optional focus record |
| `library-response.v1` | Library preferences with record summaries |
| `publication-binding.v1` | A local record's publication destination and separate revision counters |
| `public-curriculum.v1`, `public-progress.v1` | Explicit public fields, with extensions rejected at every object level |
| `published-course.v1` | One published curriculum, progress, status, revision, and publication time |
| `published-library.v1` | A published library revision and optional focus curriculum |
| `hub-description.v1` | Public connection discovery and supported sign-in methods |
| `error.v1` | A structured error response |

## Local identity and revisions

A `recordId` is a lowercase UUID and identifies one saved local record. A curriculum ID identifies content; it does not identify a unique local record. Imports may share a curriculum ID while retaining separate record IDs and progress.

A local origin is `{ "kind": "local" }`. A cloud origin includes a hub UUID, canonical HTTPS backend origin, and account UUID. Cloud cache selection must match all three fields, not just the curriculum ID. Account changes must not expose another account's cache.

`state.revision` is the local compare-and-swap counter: a save supplies the revision it read, and a successful change increments it. It applies to the entire record, including draft and navigation updates. `cloudRevision` tracks the remote publication. `publishedLocalRevision` records which local revision was published. Publishing does not change a local origin into a cloud origin.

The library has one nullable `focusRecordId`. Focus is a preference, separate from a record's `active`, `paused`, `completed`, or `saved` status. Multiple records may be active. Changing focus must not pause or delete another record.

## Legacy compatibility

Curriculum version 1 may omit `version`; a supplied version must equal `1`. Progress must specify version `1`. Unknown versions are rejected before migration. Local curriculum and progress objects retain unknown extension fields, as the existing import boundary did. Original version 1 backups remain readable; importing them does not rewrite the original file. Their envelope accepts only `curriculum`, `state`, and the optional `format` marker. Imports reject unknown envelope metadata rather than silently discarding it. Nested legacy content remains preserved, including optional `totalHours` and module `number` metadata whose values the original validator did not constrain.

Public curriculum and progress use a closed field list. A publisher must build these projections explicitly, then validate them. It must not serialize a local record or copy arbitrary extension fields. Drafts, selected modules, local record IDs, origin scope, and publication bindings stay local. Public schemas describe data shape; publication still requires the owner's explicit action and the destination's access checks.

## Semantic validation

Schemas check types, required fields, versions, known field bounds, status values, and closed envelopes. The application must also check the following rules against the complete object and current store:

- Curriculum module IDs are unique. Each prerequisite and resource reference exists. Module weeks satisfy `weekStart <= weekEnd <= curriculum.weeks`.
- Progress `curriculumId` matches the curriculum. Each progress module and experiment references a module in that curriculum. Each task list has exactly the matching module's task count.
- Complete modules have all tasks checked and nonblank evidence. Submitted experiments have a nonblank title. Schemas also enforce these rules where no external context is needed.
- A selected module and draft experiment module reference existing modules. A draft may have an empty title and no experiment ID. A nonnull draft ID is nonempty; a nonempty draft date must be a real ISO calendar date. A submitted draft with an ID must resolve to the intended experiment; save and submit must not silently target a different record.
- Nonempty `startDate` values pass the existing calendar-date parser. `publishedAt` is a real UTC timestamp. A timestamp-shaped string can still contain an impossible date.
- Focus references resolve within the current library or publication scope. A binding resolves to the named record, account, backend, hub, and curriculum. A publication cannot report a local revision newer than the saved record.
- Revision values are nonnegative safe integers, at most `9007199254740991`, so JavaScript can compare them exactly. A save with an old revision returns an error without changing stored data.
- An HTTPS origin has no credentials, path, query, or fragment, uses its canonical host spelling, and omits the default port. Parse and normalize it with a URL implementation, then require an exact match. The schema rejects common malformed forms; runtime validation must also check IP literals and the port range.
- A publishable key starts with `sb_publishable_`, or has the three-part shape of a legacy JSON Web Token (JWT). For a legacy JWT, decode the header and payload safely and require the `anon` role; reject `service_role`, malformed payloads, and other roles. Passing this structural check does not prove that the credential works or belongs to the backend. The guided connection step performs that check.

A hub link or QR code contains the hub address only. Public discovery never contains a password, email address, session token, management token, secret key, or service-role key. Unrecognized fields are rejected, including nested fields.

## Shared fixtures

`tests/fixtures/contracts/cases.json` lists each case's schema file, data file, and expected schema result (`valid`). A case marked `semanticValid: false` deliberately passes JSON Schema but must fail the relevant runtime check. Consumers must not treat schema success alone as permission to accept it. Fixture domains and credentials are synthetic; none grants access to a service.

`node --test tests/contracts.test.mjs` compiles all schemas with Ajv2020, checks every case, round-trips valid JSON without loss, checks the shipped curriculum, rejects unknown versions, and checks publication and discovery field boundaries. Python storage checks use the same fixture files for local runtime rules.
