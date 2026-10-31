# Release and recovery

Use this guide with a checkout that contains all approved release changes.
Keep the repository private until publication is approved.
The public deployment template stays disabled during that review.
Native editing, automatic two-way sync, and App Store distribution are outside this release.

## Clean local installation

Install Python 3.10 or later.
The committed web bundles can run without Node.js or an account:

```sh
python3 server.py
```

Open http://127.0.0.1:8765 and keep the terminal open.
Use Control-C to stop the server.
The default learning directory is `data/` beside `server.py`.
For a separate acceptance run, start with a new temporary directory:

```sh
TOUCHLINE_CHECK_DATA=$(mktemp -d)
python3 server.py --port 8766 --data-dir "$TOUCHLINE_CHECK_DATA"
```

Open http://127.0.0.1:8766 for that run.
Keep real learning files and deployment credentials out of this directory.
Retain it until you review the results.

## Upgrade and backups

1. Export progress for each curriculum with work to retain. Each version 2 export includes its curriculum, progress, draft, and selected lesson.
2. If saving fails, export the working copy before closing the page. Browser recovery storage can be unavailable.
3. Stop the local server. Copy the complete data directory to a separate retained location, including `library.json`, record folders, backup files, and the `_lessons/` folder when it exists.
4. Keep deployment configuration and secrets in a separate private backup. Never add them to Git or a release attachment.
5. Preserve the earlier application checkout. Install the reviewed application revision in a separate checkout and retain its exact Git commit ID.
6. Make a separate working copy of the backed-up data directory. Keep the backup untouched.
7. Start the new application with that working copy using `--data-dir`. Confirm both curricula, focus, lesson selection, notes, and unfinished experiments before publishing anything.

Do not erase browser storage during an upgrade.
It can contain unsent drafts and pending publication requests.
Theme preferences are local to each browser origin or native device and are not part of progress exports.

Import curriculum accepts a full backup when its curriculum does not already exist.
The review defaults to Save for later and offers another active curriculum.
For an existing curriculum, select it and use Restore backup.
Export the current record before accepting replacement.
A version 1 progress-only backup requires its matching curriculum.

## Lesson modules and the `_lessons/` folder

A lesson module is one lesson with one outcome. A packet is a list of lesson modules, each with an exact version.
Schola stores imported lessons in a new folder, `_lessons/`, inside the data directory.
The folder appears with the first import. A data directory with no lessons has no `_lessons/` folder.

```text
<data-dir>/
  _lessons/
    modules/<module-id>/<version>/module.json
    modules/<module-id>/<version>/source.json
    packets/<packet-id>/<version>/packet.json
    packets/<packet-id>/<version>/source.json
    pins.json
    help/<module-id>.json
    map/<curriculum-id>.json
    progress/<record-id>/<lesson-id>.json
    snapshots/s03/<record-id>/
    migrated.json
```

- `module.json` and `packet.json` hold the exact bytes that were imported. `source.json` holds the digest, the file name, and the import time.
- `pins.json` says which version of each module the student uses. It has a revision number.
- `help/` holds help records. This release stores and exports them. It does not yet add new ones.
- `map/`, `progress/`, `snapshots/`, and `migrated.json` come from the migration described below.
- A curriculum ID cannot start with an underscore. The folder never clashes with a curriculum folder.
- Older builds do not read `_lessons/`. They read only `records/`, `curricula/`, and `<curriculum-id>/state.json`.

How an import works:

1. Choose a lesson file with Import curriculum or Restore backup. Schola sends a file with a `schemaVersion` to the lesson review. It sends a curriculum or a progress backup to the older review, which has not changed.
2. The review is read only. It shows each lesson, its tasks and checks, its license, its price, a tutor harness if it has one, and any missing prerequisite. Choosing the file makes one preview call, which writes nothing. Cancel makes no further call.
3. Add these lessons is the only step that writes. The server checks every file again, writes all new folders together, and writes `pins.json` last.
4. A damaged file, an unsupported version, a file over the size limit, a packet that names a module Schola does not have, or a conflict stops the whole import. Nothing is written.

Every write goes to a temporary file first. Schola flushes the file, renames it into place, and then flushes the folder that holds it.
For an import, Schola flushes every new folder and `_lessons/` itself before it writes `pins.json`, and flushes `_lessons/` again after.
A power cut leaves either the old file or the new one, never a mix.

A version is written once. If you import the same ID and version with the same bytes, nothing changes.
If you import the same ID and version with different bytes, Schola refuses the file and keeps the stored one.

### After a crash during an import

A crash can leave two kinds of leftovers: a `.staging-*` folder in `_lessons/`, and `.touchline-*.tmp` files beside the files being written.
The next import, restore, or migration removes only those older than one hour, so it never removes the files of a write that is running now.
A crash between the folder renames can also leave module folders that no pin names yet.
Those folders do no harm. The module list shows them with no version in use.
Import the same file again. Schola reports it as already stored, writes the missing pin, and finishes the job.

If a write fails and Schola cannot undo part of it, Schola does not hide that. It answers with the code `rollback_incomplete` and names the paths, relative to the data directory.
Check those paths before you try again.

## Version pins and updates

The first version of a module becomes its pin, because nothing is replaced.
A later version is stored but never moves the pin.
The module list says "a newer version is available" and offers the switch.
Schola never switches by itself.
A switch needs two steps in the app: Review the switch, then Switch to the new version.
Choosing Keep the current version, or closing the screen, changes nothing.
The server also refuses a pin change that does not carry `confirm: true`.
Send `expectedRevision` with a switch to refuse it when the lessons changed since you read them.

## Migration of existing curricula

Existing curricula keep working with no lesson files.
`POST /api/lessons/migrate` runs a one-time migration when you ask for it.
This release does not call it on its own.

The migration works in this order:

1. It checks every original file. If one is invalid, it writes nothing.
2. It copies each original into `_lessons/snapshots/s03/<record-id>/` and checks the copy against its digest. The folder also holds `manifest.json`, which lists the digests.
3. It writes `map/<curriculum-id>.json`, which gives each lesson an ID that fits the lesson rules. An ID in a map never changes. A refresh adds an ID for a module added to the curriculum later. The ID is the curriculum ID and the lesson ID joined by a hyphen, in lowercase, with each underscore changed to a hyphen. If that ID is not valid or is already taken, Schola uses the start of the curriculum ID and eight characters of a digest instead. The table is written once and never recomputed. Task number N becomes `task-N`.
4. It writes `progress/` files for each lesson. They are copies of the record. Schola refreshes them when the migrate route runs again after a change, or when you run the command line `refresh`. Saving a record does not refresh them, so a progress file can lag behind its record until then. The record is always the source of truth.
5. It writes `migrated.json` last. A second run finds it and changes nothing.

`records/<record-id>/record.json` stays the source of truth for an existing curriculum.
The migration builds IDs only. It builds no lesson module for the existing curricula.
If a step fails, Schola removes what that run created.

### Roll back the migration

The migration and the lesson import never change an original file.
The originals are `records/<record-id>/record.json`, `<curriculum-id>/state.json`, and `curricula/*.json`.
To go back to a build that knows nothing about lessons:

1. Stop the server with Control-C.
2. Move the whole `_lessons/` folder out of the data directory. Do not delete it. Keep it in a separate folder in case you want it later.
3. Start the earlier build with `--data-dir` pointing at the same data directory.

To put an original file back from its snapshot, use the command line with the server stopped:

```sh
python3 lesson_migrate.py restore --data-dir <data-dir> --confirm
```

This restore is the one place in the lesson code that may overwrite an original record file.
It exists only to undo the migration, and it does nothing without `--confirm`.
It checks every snapshot against its digest first. A snapshot that is unfinished or damaged stops it before any write.
Work saved after the migration lives in the live file, so the restore refuses to replace a record whose revision is newer than its snapshot.
It lists those files and writes nothing. Add `--force` only when you want to give that work up.
Before it replaces any file, it keeps the old bytes under `_lessons/snapshots/s03-replaced/`.
It never deletes a file, and it is all or nothing: if a write fails, it puts back what it had replaced.
If that also fails, it stops with the code `partial_restore` and lists the files that stay replaced.

Run the command line `migrate`, `refresh`, and `restore` commands only while the server is stopped.
The pin file is read, changed, and written without a lock, so a command and a running server could overwrite each other.

## Lesson backup: export and restore

A lesson backup is a separate file with the format `schola-lesson-backup`.
The older progress backup format has not changed.
A lesson backup holds every stored module and packet as exact text with its digest, the pins, and the help records.
It holds no progress. Export progress for each curriculum as before.

To export, open `http://127.0.0.1:8765/api/lessons/export` in the browser and save the answer as a `.json` file.
Schola refuses an export that would pass 5 MB.

To restore, choose the file with Import curriculum. The review is titled Restore these lessons.
Schola checks the whole file before it writes anything. It checks the format, every digest, every module and packet, and every reference.
A restore is all or nothing.
Restoring into an empty data directory rebuilds the same files.
Restoring into a used data directory only adds what is missing:

- A version that is already stored with the same bytes is skipped.
- A version stored with different bytes stops the restore.
- A pin is set only for a module that has no pin. A restore never moves a pin.
- Help records are added after the stored ones, with no repeats.

## Size limit

A lesson request may be up to 5 MB. A single lesson file may be up to 5 MB. A request may hold up to 2000 files.
A larger request gets status 413 and writes nothing.
The other routes keep their 2 MB limit.

## Lesson routes

All lesson routes use the local address and the same Host and Origin checks as the other routes.

| Route | Use |
|---|---|
| `GET /api/lessons` | List modules, their pins, their versions, and any newer version on offer |
| `GET /api/lessons/export` | Return the lesson backup |
| `POST /api/lessons/import/preview` | Check a file and say what an import would do. Writes nothing |
| `POST /api/lessons/import` | Import a module or packet, or restore a lesson backup |
| `POST /api/lessons/pins` | Move one pin. Needs `confirm: true` |
| `POST /api/lessons/migrate` | Run the one-time migration. Send an empty object |

Import and preview take `{source, filename}`. The `source` is the file text, one parsed document, or a list of documents.
Send the text when the exact bytes matter.
The error codes are: 422 `invalid_lesson` and `missing_module`, 409 `version_conflict`, `unsupported_version`, and `revision_conflict`, 413 `payload_too_large`, and 400 for a malformed request.

## Recovery

A failed save leaves the working copy visible.
If a stale tab conflicts with a newer record, export its work before choosing Use saved version.
Do not overwrite the newer record to clear the warning.

For a damaged local record, use the recovery screen's validated retained backup.
Recovery preserves the damaged bytes and assigns a new revision.
Reload other open Schola tabs afterward.
If that screen cannot offer a valid backup, stop the server and retain the damaged files before restoring a known complete data backup.
Do not edit revision numbers or replace unknown versions with empty records.

A publication retry uses the saved request identity and original payload.
Keep its recovery storage intact and use the visible retry or conflict review.
Downloading a cloud copy requires review before replacing the selected local record.
Export first when the current local work must survive replacement.
Other curricula retain their own results and records.

Native refresh keeps the previous valid copy after a temporary request or write failure.
Confirmed loss of account access hides and removes private downloads.
An offline device can retain previously verified copies until it can check its session again.
If cleanup fails, use Retry sign-out and cleanup before connecting another account.
Local imports remain separate from private downloads.
See [Native data and recovery](../ios/README.md#data-and-recovery).

To roll back clients, use the retained compatible checkout and a copy of the saved data.
Do not remove server access restrictions, drop tables, or erase publications as a client rollback.
Unknown data versions require a compatible client or a reviewed repair.
See [Backend recovery](../backend/README.md) and [Connector setup](../hosted/README.md).

## Automated acceptance commands

Run commands from the repository root with Node.js 24, Python 3.10 or later, and PostgreSQL tools installed.
The database runners create disposable clusters with local sockets and no TCP listener.
Set `PG_BIN` to the directory containing `initdb`, `pg_ctl`, and `psql` if automatic discovery fails.

```sh
npm ci
npx playwright install chromium
git config core.hooksPath .githooks
npm run verify
npm run test:backend
npm run test:browser
npm run test:appearance
node tests/run-setup-browser.mjs
```

`verify` checks repository permissions, types, lint, Python and Node tests, and the web build.
Browser checks use temporary records and block external requests.
The lesson checks run inside `verify` and `test:browser`. `tests/README.md` lists them.
The setup suite uses fixture responses and does not grant provider permission or deploy a backend.
The packaged connector test runs within `verify` and checks its public file boundary without deployment credentials.
Read [Test runners](../tests/README.md) for individual checks.

List installed native destinations before running both device classes:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/touchline-release-build CODE_SIGNING_ALLOWED=NO build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=18.5' -derivedDataPath /tmp/touchline-release-tests CODE_SIGNING_ALLOWED=NO test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M4),OS=18.5' -derivedDataPath /tmp/touchline-release-tests CODE_SIGNING_ALLOWED=NO test
```

If either named simulator is absent, choose an installed iPhone and iPad from the list.
Run the suites serially. These commands do not sign or install a physical-device build.
Native tests use isolated storage and mocked services.
Simulator results do not prove live email delivery, provider configuration, camera access, or device file protection.

## Acceptance journey

Record the tested Git commit, command results, device destinations, and any unresolved finding outside this guide.
Complete the journey on disposable data before using an owner's deployment.

| Area | Required check |
|---|---|
| Learning | Import two curricula, keep one focus, edit both, save experiments, restart, and restore an exported backup. |
| Lessons | Import a lesson file and cancel the review. Import it again and confirm. Restart and check the module is still there. Import a damaged file and a changed copy of a stored version. Import a newer version and check that the pin stays until you switch. Export the lesson backup and restore it into an empty data directory. |
| Draft recovery | Keep an unfinished experiment through navigation and relaunch. Test failed saving and stale-tab recovery without losing the newer record. |
| Setup | Review the actual destination, cancel permission, recover partial preparation, and verify discovery and backend health before accepting readiness. |
| Publications | Publish two curricula independently. Resolve one conflict while preserving the other course and local backups. Publish focus separately. |
| Accounts | Reject anonymous, unconfirmed, non-owner, wrong-hub, and wrong-account access. Test sign-out, revocation, and a failed backend switch. |
| Native reading | Select downloads on iPhone and iPad, launch offline, open sources, then refresh after a new publication. Preserve valid copies after a temporary failure. |
| Appearance | Test both theme pairs in Dark, Light, and System. Change system appearance, dismiss the panel, and relaunch without losing drafts or navigation. |
| Accessibility | Check keyboard access, visible focus, labels, larger text, contrast, reduced motion, and screen-reader reading order. |
| Review | Complete independent code, security, and failure-handling reviews plus a bounded visual and motion review. |

## Owner checks still required

Automated fixtures do not complete these live checks:

- Deploy the connector to the owner's Vercel project with the owner's PostgreSQL database. Verify the fixed HTTPS address and public discovery boundary.
- Configure both owner-controlled Supabase OAuth registrations. Check real permission grant, cancellation, cleanup, and partial setup recovery.
- Check real email-code delivery and return behavior. Check Google and Apple only if enabled, including the same pinned owner identity.
- Confirm native provider returns on the installed app and web returns on the original local browser. A hosted return page does not finish local sign-in.
- Sign and install the native app with the owner's Apple team. Check camera permission, QR scanning, source opening, and account cleanup on physical iPhone and iPad.
- Check file protection across device restart and first unlock. Check VoiceOver manually on both device classes, including larger text and appearance controls.

Follow [Owner-hosted deployment](../hosted/README.md) and [Native installation](../ios/README.md#install-on-your-device).
Keep encryption keys, database credentials, and provider secrets on the owner's server.
The one-time setup code is entered only at the verified owner HTTPS setup page.
Schedule the documented operator cleanup command for expired setup grants. No automatic scheduler is included.
Complete live checks only with the required owner approval, and retain their results before release.
