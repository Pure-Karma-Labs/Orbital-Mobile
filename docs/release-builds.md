# Release Build Guide

## Prerequisites

- **iOS:** Active Apple Developer Program membership, Xcode installed
- **Android:** Release keystore generated (see below), `android/keystore.properties` populated

## iOS

For how prebuilt SDKs (the Sentry xcframework) reach the build and what keeps
`Podfile.lock` reproducible, see [ios-dependency-delivery.md](ios-dependency-delivery.md).

Before archiving, confirm `.env` contains a valid `SENTRY_DSN` entry. The build reads
`.env` via react-native-config (see `node_modules/react-native-config/ios/ReactNativeConfig/ReadDotEnv.rb`);
`.env.local` is not a build input. If `SENTRY_DSN` is absent, `src/sentryInit.ts` disables
the Sentry SDK silently — the archive succeeds but crash reporting is off.

1. Build the Rust crate with the release cargo profile (also runs `pod install`):
   ```bash
   npm run build:rust:ios:release
   ```
   This writes `release` to `packages/orbital-signal/rust-profile-ios.txt`. The Xcode build
   includes an **[Orbital] Verify Rust release profile** script phase that checks this marker
   and fails the build if it reads anything other than `release`. Skipping this step will cause
   Archive (and any Release configuration build) to fail with:
   `error: OrbitalSignal xcframework was built with Rust profile '<profile>', not 'release'.`

2. Open `ios/OrbitalMobile.xcworkspace` in Xcode
3. Select the **OrbitalMobile** target, verify signing shows your team under **Signing & Capabilities**
4. Set destination to **Any iOS Device (arm64)**
5. **Product > Archive**

   The archive triggers an **Upload Debug Symbols to Sentry** build phase (wired via
   `ios/Podfile` `script_phase`, written to `project.pbxproj` by CocoaPods as a
   `[CP-User]` phase). This phase runs `sentry-xcode-debug-files.sh`, which uploads the
   app dSYM so that native crashes in Sentry symbolicate correctly instead of arriving as
   `native_missing_dsym`. What you need:

   - `ios/sentry.properties` must contain `auth.token=<sntrys_ token>` (gitignored; the
     `defaults.org` and `defaults.project` entries already committed there tell sentry-cli
     which project to target).

   In the archive log (Xcode → Report navigator → build transcript) look for:

   - Success: `sentry-cli - > Uploaded N missing debug information files` or
     `sentry-cli - File upload complete`
   - Failure: `error: sentry-cli - Debug files upload failed`

   The script skips any configuration whose name contains "Debug" by name, so local Debug
   builds never need Sentry credentials.
   If you need to make a failing upload non-fatal, set `SENTRY_ALLOW_FAILURE=true` in
   the scheme's environment — this downgrades the build phase exit to a warning.
   The correct kill switch for native-only dSYM upload is
   `SENTRY_DISABLE_XCODE_DEBUG_UPLOAD=true` (not `SENTRY_DISABLE_AUTO_UPLOAD`,
   which also skips JS source maps).

6. In the Organizer, select the archive and **Distribute App > App Store Connect**

The project uses automatic signing (`CODE_SIGN_STYLE = Automatic`). Xcode manages certificates and provisioning profiles via your Apple Developer account.

## Android

### One-time keystore setup

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore android/app/orbital-release.keystore \
  -alias orbital-release -keyalg RSA -keysize 2048 -validity 10000
```

Create `android/keystore.properties` (gitignored):

```properties
storeFile=orbital-release.keystore
storePassword=<YOUR_PASSWORD>
keyAlias=orbital-release
keyPassword=<YOUR_PASSWORD>
```

### Build release-profile Rust binaries

Before building a signed APK or AAB, compile the Rust crate with the release cargo profile:

```bash
npm run build:rust:android:release
```

This writes `release` to `packages/orbital-signal/android/src/main/jniLibs/rust-profile.txt`.
The Gradle `checkRustBinaries` task verifies this marker on every Release variant build.
If the marker is missing or reads `debug`, the build will fail with:
`Release build requires release-profile Rust binaries, but found profile '<profile>'.`

### Build signed AAB (for Play Store)

```bash
cd android && ./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

### Build signed APK (for side-loading / testing)

```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

## Keystore Management

The Android release keystore is backed up as a base64-encoded GitHub Secret (`RELEASE_KEYSTORE_BASE64`). **If the keystore is lost, you cannot update the app on Google Play** -- you would need to create a new listing.

To restore from backup:

```bash
gh secret list --repo Pure-Karma-Labs/Orbital-Mobile  # verify secrets exist
# Secrets cannot be read back via CLI -- restore from the original backup
```

Consider enrolling in Google Play App Signing after first upload. This makes the local keystore an upload-only key that can be rotated if compromised.

## CI Notes

CI builds use `CODE_SIGNING_ALLOWED=NO` (iOS) and only run debug builds (Android). The release signing config gracefully degrades when `keystore.properties` is absent -- CI debug builds are unaffected.

CI intentionally builds debug-profile Rust. The rust-cache `shared-key` values (`rust-build-android`, `rust-build-ios`) do not encode the Rust profile. If a CI release build step is ever added, the cache key must be split to avoid cross-contamination between debug and release target directories.

The iOS CI build runs with `SENTRY_DISABLE_AUTO_UPLOAD=true`, which makes the **Upload Debug Symbols to Sentry** phase a no-op (the phase still runs but skips all uploads). No `SENTRY_AUTH_TOKEN` secret exists in the CI workflows today. A future CI Release build step would need `SENTRY_AUTH_TOKEN` added as a GitHub Secret and passed via the build environment. The kill switch for the native dSYM upload specifically (without also disabling JS source map upload) is `SENTRY_DISABLE_XCODE_DEBUG_UPLOAD=true`.
