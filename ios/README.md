# Touchline for iPhone and iPad

This is a native SwiftUI companion for reading curricula and published progress.
It opens source links, shows experiment records, and stores downloaded courses for offline reading.
The application includes the soccer curriculum for initial reading.
It can also import a progress backup from the desktop hub.
The native companion does not edit progress in this version.

## Build

Open `Touchline.xcodeproj` in Xcode 16.4 or later.
Install the iOS platform and a simulator runtime through Xcode Settings if they are missing.
Select an iPhone or iPad simulator.
Run the Touchline scheme.

For a command-line build, run this command from the repository root after the simulator platform is installed:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

## Install on your device

Sign into Xcode with your Apple account.
Select your team in the target's Signing & Capabilities tab.
Change the bundle identifier if your team needs a different identifier.
Connect your iPhone or iPad to your Mac.
Select the device as the run destination.
Enable Developer Mode on the device if Xcode requests it.
Run the application from Xcode.

The default bundle identifier is `love.hannasage.touchline`.
Other developers must choose their own bundle identifier and signing team.
No Apple account credentials are included in this repository.

Apple documents device installation here:
https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html

## Connect your hub

Open Backend and account, then enter your hub's HTTPS address or scan its QR code.
The app reads `/.well-known/touchline.json` without account credentials or redirects.
Review the hub name, address, backend address, and hub ID before continuing.
A hub link finds a destination; it does not grant access.
`touchline://connect?hub=<URL-encoded HTTPS origin>` opens the same review flow.
Camera permission is optional. Cancel scanning or enter the address when permission is denied.

Email codes are the default sign-in method.
The backend's owner allowlist controls whether a new account may be created.
The app shows Google and Apple only when the hub description enables them.
Those methods open an isolated system sign-in browser and return to this app.
Supabase or Vercel setup authorization stays in the desktop setup connector.
Raw backend key files and password entry are no longer public connection flows.

The owner's Supabase redirect allowlist must include:

```text
love.hannasage.touchline://auth/return\?attempt=*
```

The escaped question mark matches a literal query separator in Supabase's glob rules.
Each request uses a new random attempt ID, the SDK's PKCE verifier, and a ten-minute return window.
The app accepts only the expected scheme, host, path, attempt ID, and one code.
It consumes the return before exchange; links, camera results, and unsolicited callback URLs never create a session.
The source declares URL schemes and camera usage in `Touchline/Info.plist`.
No associated domain, Apple account change, or device provisioning is needed for the simulator flow.

Before private reads, the app verifies the current user with Supabase and checks confirmed email and nonanonymous identity.
It calls `register_touchline_session`, checks the returned account and session identifiers, then uses the verified token for that transfer.
Auth storage is separate for each explicit hub ID and backend origin; reading copies also include the account ID.
Sign-out revokes the current backend session, clears its SDK session, and removes private downloads.
Failed cleanup stays visible after relaunch and blocks another connection until retry succeeds.

## Offline reading

Downloaded courses remain readable without a connection.
The last download time appears in the course list.
External sources require internet access.
Sign out to remove downloaded private courses from this device.
Changing backends hides the previous account and removes its downloaded file.
Local imports and the bundled curriculum remain available.
If removal fails, the app reports the failure and keeps private content hidden.
Use Retry sign-out and cleanup when storage or account access is available.

## Reading your library

The library shows the published focus when the hub provides one.
Other downloaded curricula remain grouped by their published status.
Included and imported copies stay separate from account downloads.
The reader never chooses a focus from the order of the courses.

Each curriculum keeps its lesson and source location while the app stays open.
Refreshing a valid copy preserves that location when the lesson still exists.
Removing a course or ending its account session clears its private navigation.
The companion shows saved progress, notes, evidence, time, and experiments without editing them.

Read sources opens the original website and leaves the lesson in place.
If the system cannot open a link, the app offers retry guidance and a share action.
The downloaded lesson includes the curriculum text, but not linked books or datasets.
Devices lists the copies already stored here and the last successful download.
Open Backend and account to choose or remove downloads.
The catalog transfers titles, status, and revision numbers; full lesson and progress records are fetched only for selected curricula.
The published focus is suggested first, and any other curricula may be selected.
Each selected curriculum refreshes independently and keeps its own successful download time.
A failed or invalid response preserves that curriculum's previous valid copy while other selections can finish.
Removing a download removes only this device's reading copy, not the publication in the hub.
Local notes and experiments remain read-only in the native companion.

The hub must expose the version 1 published-library view for a connected refresh.
An absent or invalid view fails the refresh without replacing the previous reading copy.
Older native cache files without library metadata remain readable with no inferred focus.

## Appearance

Open Theme from the library, the current lesson, or Devices.
Choose Noir Bloom with Confetti Studio, or Dusk Protocol with Coastal Day.
Dark and Light override the device appearance. System follows changes to the device appearance while the app stays open.
The choices stay on this device and survive relaunch. Changing them keeps the current curriculum and lesson in place.

On iPhone, the choices open in a sheet with Done and swipe dismissal.
On iPad, they open beside the Theme control and close when you tap Done or outside the panel.
Large text can scroll through all choices. The mode controls stack when accessibility text sizes need more room.

## Data and recovery

Each account has a separate cache file keyed by hub, canonical backend origin, and account ID.
The app saves a complete replacement before it changes the visible downloads.
A temporary network failure, invalid snapshot, or failed write leaves the last valid copy intact.
A confirmed expired, revoked, or unauthorized account hides and removes its private copies instead.
An offline launch can read a previously verified account's saved copies; the next available backend check can revoke that access.
Local imports use separate identities, even when their curriculum IDs match a cloud download.
Import collections have a 20 MB limit; larger replacements leave the saved file intact.
If the saved import file cannot be read, new imports are blocked and the original bytes stay intact.
Restore that file from a known valid backup and restart the app before importing more curricula.

The old `courses.json` file has no account identity.
The app leaves that file untouched and excludes it from the active library.
Import a trusted original backup to recover a local reading copy.
The app never assigns the old cache to the next account that signs in.

Writes request iOS file protection until the first device unlock after restart.
The simulator does not expose the protection attribute, so this requires a physical-device check before release.
Appearance preferences remain separate from learning records.

`ContractReader` validates the bundled P02 schemas before decoding data.
It supports only the schema keywords used in those contracts and rejects unknown keywords and unresolved references.
It also checks curriculum references, calendar dates, versions, and backend origins.
It is not a general JSON Schema validator.
Shared schemas and fixtures are Xcode folder resources referenced from the repository root, with no copied fork.

## Tests

The shared Touchline scheme includes `TouchlineTests` and `TouchlineUITests`.
Tests use temporary storage, isolated preferences, and an injected service that makes no network requests.
The application test host also starts with isolated storage and network disabled.
Unit tests cover shared fixtures, account changes, duplicate curriculum IDs, corrupt data, failed writes, sign-out cleanup, and offline relaunch.
The interface tests cover offline reading, both theme pairs, every appearance mode, live device changes, preference relaunch, and the largest text size.
Connection tests intercept SDK and discovery requests, including email creation, owner verification, session registration, revocation, PKCE, hostile returns, cancelled requests, and selected refresh failures.
UI tests use a disposable fixture hub, fixed test code, mocked camera denial, and no live service or camera.
The simulator checks do not establish physical-camera behavior or production provider configuration.
The interface test opens the bundled library and relaunches it without a backend.

List available destinations on the current machine:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
```

Run the suite from the repository root on both device classes:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=18.5' -derivedDataPath /tmp/touchline-native-tests CODE_SIGNING_ALLOWED=NO test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Touchline.xcodeproj -scheme Touchline -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M4),OS=18.5' -derivedDataPath /tmp/touchline-native-tests CODE_SIGNING_ALLOWED=NO test
```

If those devices are absent, choose an installed iPhone and iPad from the destination list.
Device signing and production account tests remain separate release steps.

## Dependencies

Supabase Swift is pinned to version 2.55.5.
Xcode records resolved dependencies in `Touchline.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
The app uses native SwiftUI controls with the Projection palette.
Projection UI itself is a React library and is used in the web hub.
