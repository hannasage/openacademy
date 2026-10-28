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
Changing backends also clears downloaded courses.

## Dependencies

Supabase Swift is pinned to version 2.55.5.
Xcode records resolved dependencies in `Touchline.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
The app uses native SwiftUI controls with the Projection palette.
Projection UI itself is a React library and is used in the web hub.
