# Apple applications

SwiftUI applications host the web interface in persistent WKWebViews, with native composer, navigation, file and notification bridges. Targets support iOS17+ and macOS14+. The project pins FirebaseCore and FirebaseMessaging12.19.2; use Xcode26.2+.

The checked-in project uses `com.example.assistant` bundle identifiers, no development team, and `https://assistant.example.com/` as its application origin. Replace these with your own values before installation. The origin check deliberately restricts bridge access to the configured application origin.

## Unsigned builds

From the repository root:

```sh
xcodebuild -project apps/apple/Assistant.xcodeproj -scheme Assistant-macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath apps/apple/build/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/apple/Assistant.xcodeproj -scheme Assistant-iOS -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath apps/apple/build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

To regenerate the project after adding sources, install the `xcodeproj` Ruby gem and run `ruby apps/apple/generate-project.rb`. The generator also needs your origin and bundle settings; update its defaults or pass `ASSISTANT_APP_ORIGIN` and `ASSISTANT_BUNDLE_PREFIX`. An optional ignored `LocalConfiguration/Signing.json` with a `developmentTeam` field supplies the Apple team.

Add each target's Firebase plist to ignored `LocalConfiguration/ios/GoogleService-Info.plist` or `LocalConfiguration/macos/GoogleService-Info.plist`. Without these files, the source can build but Firebase push registration is not configured.

ChatGPT connection settings in the native Mac app offer local-browser or VM login. Local login opens the system browser and receives a single-use OAuth callback on a loopback listener; PKCE verification and credentials remain on the daemon. The macOS network-server entitlement enables that callback listener. Other clients continue to offer VM login.

## Distribution

The export plists under `Configuration` are templates; supply your team and provisioning. Use App Store Connect for TestFlight, or Developer ID signing and notarization for direct Mac distribution. Do not distribute a development-signed app as a notarized release.

After notarization, `ASSISTANT_DEVELOPMENT_TEAM=YOURTEAMID ASSISTANT_MACOS_BUNDLE_ID=com.example.assistant.macos bun scripts/package-macos.mjs /path/to/Assistant.app /path/to/Assistant.zip` verifies signing, the stapled ticket and Gatekeeper before packaging. It refuses to overwrite an existing archive.

Unsigned builds and simulator checks do not establish APNs delivery or recipient installation. Validate these separately on your devices.
