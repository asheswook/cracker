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
# Native shell

Navigation and presentation are owned by SwiftUI: macOS uses a sidebar/detail
`NavigationSplitView`, trailing inspector, and a `Settings` scene; iOS uses a
`NavigationStack` and medium/large sheets. The iOS composer remains UIKit and its
`keyboardLayoutGuide` is the only keyboard avoidance owner. SwiftUI keyboard
avoidance is disabled only on the conversation surface. System containers handle
Reduce Motion; reader positioning does not add custom animations.

The conversation WKWebView and optional computer/settings sheet WKWebViews share
the default website data store and process pool. Lists use `URLSession` GETs with
the web session cookies, no separate token persistence, cache, or redirects.
The memory endpoint is `/v1/memory` (singular). Failures are shown inline.

`window.__ASSISTANT_SHELL__` selects the version-1 body/panel adapter in the web
app. `shellState` publishes authentication and selection; `__assistantShellCommand`
selects a conversation and acknowledges it. **This app requires the matching web
adapter from this revision.** An older deployed web app does not support native
conversation selection. Do not deploy as part of local QA.

Legacy v1 hybrid negotiation is retained for the existing native composer and
reader. Header/footer packets are acknowledged but never activate independent
renderers; inline status and attachment content stays in the conversation body.
There are no independent header/footer WKWebViews or snapshot panel transitions.
Legacy web protocol tests remain for browser/older-host compatibility; native
container coverage is `Tests/ShellNavigation/NativeShellUITests.swift`.

For read-only UI QA, install the unsigned simulator build using the default
`com.example.assistant.ios` identifier and run that XCTest against a local web
build with a read-only API proxy. The test opens the current conversation, focuses
but does not type/send, opens a sheet, closes it, and edge-swipes back to the list.
Do not use production send operations to validate haptics.
