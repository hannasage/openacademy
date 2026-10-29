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

## Connect your backend

In the desktop hub, open Devices and export its connection file.
Transfer the file to your iPhone or iPad.
Use Import file in the native app to select it.
Sign in through Backend and account.
Refresh published courses.

Only the Supabase URL and publishable key belong in the connection file.
Never use an administrative key in this app.
Create and confirm your owner account in the desktop hub before signing in here.

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
Download selection and the new account flow follow in the connection release.

The hub must expose the version 1 published-library view for a connected refresh.
An absent or invalid view fails the refresh without replacing the previous reading copy.
Older native cache files without library metadata remain readable with no inferred focus.

## Data and recovery

Each account has a separate cache file keyed by hub, canonical backend origin, and account ID.
The app saves a complete replacement before it changes the visible downloads.
A failed request, invalid snapshot, or failed write leaves the last valid copy intact.
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
