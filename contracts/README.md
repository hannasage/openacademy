# Schola contracts

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
| `lesson-module.v1` | One single-lesson module: outcome, content, tasks, hint ladders, checks, optional harness, license, optional price |
| `packet.v1` | An ordered set of lesson module references, each with an exact version |
| `help-record.v1` | One hint request, with the attempt it follows |
| `lesson-common.v1` | Shared definitions for the three schemas above |

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

## Lesson modules and packets

The three lesson contracts are new and additive. They change no existing schema, fixture, or storage key. Their identifiers use the form `urn:schola:contract:<name>:v1`. The older contracts keep their `urn:touchline:contract:*` identifiers.

### Two meanings of module

In the curriculum contract, a module is a multi-week unit. It has `weekStart` and `weekEnd`. In the lesson contracts, the unit is a lesson module. A lesson module is one lesson with one outcome and one piece of verified work. It has no weeks. The schema and file names always say `lesson-module`. Never read one as the other.

### Files

- `lesson-module.v1` holds `schemaVersion`, `id`, `version`, `title`, `outcome`, `blocks`, `tasks`, `checks`, `prerequisites`, `license`, and the optional `harness`, `estimatedMinutes`, and `price`.
- `packet.v1` holds `schemaVersion`, `id`, `version`, `title`, and `modules`. Each entry in `modules` is an `id` and an exact `version`. A packet holds references, not module content. A packet with one entry is how a single module travels as a packet. `packetFromModule` in `validate.mjs` builds that packet from a module.
- `help-record.v1` holds `schemaVersion`, `moduleId`, `taskId`, `level`, `attemptId`, `timestamp`, and `source`.
- `lesson-common.v1` holds the shared patterns for ids, versions, hint levels, and timestamps.

Every object is closed, with one exception. The `runner` descriptor of a check is open, because its shape belongs to the check runner. It must be an object with a `type` string.

### Choices and their reasons

- `schemaVersion` is a string in the form `MAJOR.MINOR`, such as `1.0`. The schemas accept major version 1 and any minor number. Objects are closed, so a document with new fields needs a schema that knows them. A reader that sees an unknown field in a `1.x` document reports it as invalid.
- The content `version` of a module and a packet is a three-part string such as `1.2.0`. A plain integer cannot tell a fix from a new feature. A pre-release suffix is not allowed. A packet entry must name one exact version, never a range.
- Ids use lowercase letters, digits, and hyphens, start with a letter or digit, and hold at most 60 characters. This pattern is stricter than the curriculum module id pattern, so ids are safe in file names and links.
- Block, task, and check ids use the same pattern. They are unique inside one module.
- A block has one of four types. `text` holds a body. `source-link` holds a title and an `http` or `https` link. `interactive-code` holds a language and starter text. `check-reference` names a check declared in the same module.
- A task holds a prompt and a hint ladder. The ladder has exactly four entries. The levels are `nudge`, `question`, `partial-example`, and `full-answer`, in that order.
- A check has a `kind`. The kind `automated` needs a `runner` descriptor. The kind `self-reported` must not have one.
- A harness reference holds an id and `requiredPermissions`. The list is empty or holds names from a closed set. The set is the tutor call surface: `get_lesson`, `get_attempt`, `run_check`, `request_hint`, and `log_reflection`. A harness may add context. It never widens what an agent may do, so no other permission name is valid.
- `prerequisites` is a list of module ids. It is advice only. A reader warns about a missing prerequisite and never blocks on it.
- `license` is an object with an `id`, such as an SPDX identifier, and an optional link.
- `price` is optional. An absent price means no price is set. The `amount` is an integer in minor units, such as cents. The `currency` is a three-letter ISO 4217 code in capitals. These fields describe a price. They carry no payment logic.

### Checks hold descriptors, not code

The module contract does not hold executable code in a check. A check holds a `description` and, for an automated check, a `runner` descriptor. A runner reads the descriptor and decides what to do. The `interactive-code` block holds starter text for the student to edit. It is data. No reader may run it or any runner field unless the reader first shows the student what will run and the student agrees.

### Help records and the full answer

Every hint request makes one help record. The `attemptId` field is always present. It may be `null` only for the levels `nudge` and `question`. The levels `partial-example` and `full-answer` need the id of a logged attempt. This is how the contract keeps the full answer behind a logged attempt. The `source` is `student` or `agent`. The `timestamp` follows RFC 3339.

### Validator

`contracts/validate.mjs` exports these functions:

- `validateLessonContract(kind, document)` checks a parsed document. The kind is `lesson-module`, `packet`, or `help-record`.
- `validateLessonText(kind, text)` parses JSON text first. Text that is not complete JSON gives an invalid result.
- `validateLessonFile(kind, file)` reads a file first. A file that cannot be read gives an invalid result.
- `packetFromModule(module)` builds the one-entry packet for a module.

A call returns `{ ok: true }` or `{ ok: false, reason, errors }`. Each error is `{ pointer, message }`, where `pointer` is a JSON Pointer into the document. The `reason` is `invalid` or `unsupported_version`.

The validator never changes its input. It never writes a file. It opens files for reading only. A damaged file or a file with an unsupported version stays exactly as it was.

### Unknown major versions

A reader supports a list of major versions. Today the list is `1`. A reader reads `schemaVersion` first. If the major number is not in its list, it stops. It returns `unsupported_version`, it reports only `/schemaVersion`, and it does not look at any other field. A reader never tries to repair, migrate, or rewrite such a file. A marker that is not in the `MAJOR.MINOR` form is `invalid`.

### Semantic checks

A schema alone cannot check these rules. `validate.mjs` checks them after the schema passes:

- Module ids are unique in a packet.
- Block ids, task ids, and check ids are unique in a module.
- Every `check-reference` block names a check that the module declares.
- Every prerequisite is a valid module id and is not the id of the module itself. A prerequisite does not need to be in the same packet.
- Every hint ladder holds the four levels in the required order.
- A help record timestamp names a day that exists. The schema alone accepts a date such as 30 February.

A help record does not name a module in the same document. A tool that holds both must also check that `moduleId` and `taskId` exist in the module. That check belongs to the tool.

### Fixtures and conformance

The fixtures are in `tests/fixtures/contracts/valid/` and `tests/fixtures/contracts/invalid/`. Their names start with `lesson-module-`, `packet-`, or `help-record-`. The file `tests/fixtures/contracts/lesson-conformance.json` lists every one of them. Each entry has these fields:

- `name` is a unique label.
- `kind` is `lesson-module`, `packet`, or `help-record`.
- `file` is a path relative to `tests/fixtures/contracts/`.
- `expect` is `valid`, `invalid:invalid`, or `invalid:unsupported_version`.
- `stage` names where a document first fails. It is `none`, `parse`, `version`, `schema`, or `semantic`.

Another implementation, for example a Rust service, proves conformance in these steps:

1. Load every `contracts/*.schema.json` file as a draft 2020-12 schema. Register each by its `$id`.
2. For each manifest entry, read the file as text. Do not change it.
3. Parse the text as JSON. A parse failure is the result `invalid`.
4. Read `schemaVersion`. If it has the `MAJOR.MINOR` form and the major number is not supported, the result is `unsupported_version`.
5. Validate the document against the schema for its `kind`. A failure is `invalid`.
6. Run the semantic checks above. A failure is `invalid`.
7. Compare the result with `expect`. Every entry must match.
8. Check that every file has the same bytes after the run.

An implementation that applies only steps 1 to 5 passes every entry whose `stage` is not `semantic`. It must apply step 6 to pass the rest. The Node test is `tests/lesson-contracts.test.mjs`. Run it with `node --test tests/lesson-contracts.test.mjs`.
