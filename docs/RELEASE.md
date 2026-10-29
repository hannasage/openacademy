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
3. Stop the local server. Copy the complete data directory to a separate retained location, including `library.json`, record folders, and backup files.
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

## Recovery

A failed save leaves the working copy visible.
If a stale tab conflicts with a newer record, export its work before choosing Use saved version.
Do not overwrite the newer record to clear the warning.

For a damaged local record, use the recovery screen's validated retained backup.
Recovery preserves the damaged bytes and assigns a new revision.
Reload other open Touchline tabs afterward.
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
