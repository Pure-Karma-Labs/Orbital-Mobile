# iOS Dependency Delivery

How prebuilt native SDKs reach the iOS build, which versions are pinned where,
and what keeps `Podfile.lock` reproducible across machines.

---

## Sentry

### Delivery mechanism

`@sentry/react-native` ships a Ruby helper (`scripts/sentry_utils.rb`) that
`RNSentry.podspec` requires. During `pod install` the podspec calls two functions:

1. **`ensure_sentry_xcframework`** — downloads
   `Sentry.xcframework.zip` from the sentry-cocoa GitHub Release into
   `~/Library/Caches/sentry-react-native/xcframeworks/<ver>/` and verifies the
   SHA256 against `SENTRY_COCOA_XCFRAMEWORK_CHECKSUMS` in `sentry_utils.rb`.
   Verification runs on the **first download only** — `sentry_utils.rb:116`
   returns early when `Info.plist` already exists in the cache directory.

2. **`stage_sentry_xcframework_in_pods`** — creates a symlink at
   `ios/Pods/sentry-xcframeworks/<ver>/Sentry.xcframework` pointing into the
   cache directory above. Returns `"$(PODS_ROOT)/sentry-xcframeworks/<ver>/Sentry.xcframework"`.

3. **Podspec xcconfig injection** — writes
   `$(PODS_ROOT)/sentry-xcframeworks/<ver>/Sentry.xcframework/<slice>` into
   ten per-SDK `FRAMEWORK_SEARCH_PATHS` keys (both `pod_target_xcconfig` and
   `user_target_xcconfig` for the RNSentry and OrbitalMobile targets).

Because the path written into `Pods/Local Podspecs/RNSentry.podspec.json` uses
`$(PODS_ROOT)` — a CocoaPods build variable, not a `$HOME`-relative literal —
the RNSentry **SPEC CHECKSUM** is now machine-independent and `Podfile.lock` is
reproducible. `Sentry (x.y.z)` no longer appears as a resolved pod in
`Podfile.lock`; only `RNSentry (x.y.z)` does.

The xcframework is consumed only through `FRAMEWORK_SEARCH_PATHS` (no pod
dependency, no `vendored_frameworks`), so CocoaPods copies **no Sentry resource
bundle** into the app. The source pod used to ship `Sentry.bundle/PrivacyInfo.xcprivacy`;
after #768, `ios/OrbitalMobile/PrivacyInfo.xcprivacy` is the **sole carrier** of
Sentry's required-reason API declarations (it already declares a superset), and
Sentry's collected-data rows (`PerformanceData`, `OtherDiagnosticData`) appear
nowhere in the bundle — adding them to the app manifest is a store-compliance
decision, not a build one.

### Version record

| What | Value | Where it lives |
|---|---|---|
| `@sentry/react-native` | 8.22.0 | `package.json` / `package-lock.json`; `RNSentry (8.22.0)` in `ios/Podfile.lock` |
| sentry-cocoa | 9.19.1 | **Enforced:** `expected_sentry_cocoa` in the Issue #768 guard in `ios/Podfile` (pod install fails if the staged version differs). Upstream source: `sentry_cocoa_version` in `node_modules/@sentry/react-native/RNSentry.podspec` |
| `Sentry.xcframework.zip` SHA256 | `d6d545af17e49851cda2747b0f45cde78ce08ea37709dde5a956c6b4671224e8` | `SENTRY_COCOA_XCFRAMEWORK_CHECKSUMS['9.19.1']['Sentry']` in `sentry_utils.rb`; independently matched against sentry-cocoa's `Package.swift` binary-target checksum at tag 9.19.1 |
| Local cache | `~/Library/Caches/sentry-react-native/xcframeworks/9.19.1/` | Build machine; CI cache key `sentry-xcframework-<os>-<hash of podspec + sentry_utils.rb>` |

**Note:** nothing verifies the SHA256 row against `node_modules` at install
time; the Podfile literal enforces the version row. Next bump is #743, which
must update this table, the Podfile literal (`expected_sentry_cocoa`), and
re-do the `Package.swift` comparison.

### Provenance policy (decided 2026-09-15)

**Accept-and-name.** Rely on the upstream SHA256 at first download and record
it here; no per-install re-verification, no ephemeral cache dir, no committed
digest. All development and production (App Store) builds are produced on
Alex's Mac mini, so that one cache directory is the provenance boundary.

CI's `actions/cache` copy (key `sentry-xcframework-*`) is restored **without**
re-verification and is never on the release path. Shipping any artifact built
on a runner would make that cache a supply-chain input.

**Re-verify:** `rm -rf ~/Library/Caches/sentry-react-native && (cd ios && pod install)`

---

## Guards (Sentry)

| Guard | Where it runs | What it checks |
|---|---|---|
| Issue #768 `post_install` in `ios/Podfile` | Every machine, every `pod install` | Staged version set equals `expected_sentry_cocoa`; symlink exists and `Info.plist` is reachable through it; `$(PODS_ROOT)` reference present in `RNSentry.podspec.json`; then runs `scripts/assert-no-absolute-pod-paths.sh` |
| `scripts/assert-no-absolute-pod-paths.sh` | From the Podfile hook on every machine; `ci.yml` after `pod install --deployment` (incl. after a failed `--deployment`); `build.yml` after bare `pod install` | The leak pattern and required-file list defined in the script (single home) over every podspec JSON and xcconfig under `ios/Pods` |
| `pod install --deployment` + tree-clean diff | `ci.yml` | Lock drift — fails if `Podfile.lock` changes after a deployment install |

**Never set `SENTRY_USE_XCFRAMEWORK=0`** (in `ios/Podfile` or your shell). The
Podfile opt-out was removed in #768; `@sentry/react-native` ≥ 8.23 raises on
it, and the Issue #768 `post_install` guard fails without the staged xcframework.

---

## Re-check trigger (Sentry)

Any `@sentry/react-native` bump (next: #743, targets ≥ 8.23 / sentry-cocoa 9.24):

1. Confirm `stage_sentry_xcframework_in_pods` still returns a
   `$(PODS_ROOT)/sentry-xcframeworks/...` path.
2. Confirm the checksum table in `sentry_utils.rb` has the new version.
3. Bump `expected_sentry_cocoa` in `ios/Podfile`.
4. Run `pod install` from the **main checkout** (not a worktree — worktree
   installs poison the ReactCodegen SPEC CHECKSUM).
5. Update the Version record table above.
6. Confirm `ios/OrbitalMobile/PrivacyInfo.xcprivacy` still covers the SDK's
   `NSPrivacyAccessedAPITypes` (the app manifest is the only carrier now).
7. On CI the restored `ios/Pods` cache may still hold the previous
   `sentry-xcframeworks/<old>` entry beside the new one; the guard fails on two
   versions — `rm -rf ios/Pods/sentry-xcframeworks` and re-run, or expect the
   first run after the bump to need a cache-clearing retry.

---

## Firebase

### Delivery mechanism

`@react-native-firebase/app` ships `firebase_spm.rb`, which `RNFBApp.podspec` and
`RNFBMessaging.podspec` require. On React Native ≥ 0.75 with `$RNFirebaseDisableSPM`
unset, `firebase_dependency` calls RN's `spm_dependency` instead of `s.dependency`:

1. RN's `scripts/cocoapods/spm.rb` writes an `XCRemoteSwiftPackageReference` for
   `https://github.com/firebase/firebase-ios-sdk.git` into **`Pods.xcodeproj`** with
   product dependencies FirebaseCore + FirebaseInstallations (RNFBApp) and
   FirebaseMessaging (RNFBMessaging). It deletes and re-adds every package reference
   on each `pod install`; the `[SPM] ...` log lines print in every mode. Because
   `Pods.xcodeproj` sets `SYMROOT` (legacy build locations), it can no longer be built
   with `xcodebuild -project` once it carries a package reference — build pod targets
   through the workspace and their generated schemes.
2. RNFB's `post_integrate` wrapper writes into the **app project**
   (`ios/OrbitalMobile.xcodeproj`): one package reference to the same URL, a
   `FirebaseCore` product dependency + Frameworks build file on the OrbitalMobile
   target (so `AppDelegate.swift`'s `import FirebaseCore` links), two `[RNFB]` shell
   phases (embed SPM dynamic frameworks; remove duplicate binary-xcframework
   `.signature` files at Archive), and `CLANG/SWIFT_ENABLE_EXPLICIT_MODULES = NO` +
   `SWIFT_INCLUDE_PATHS` on the app target. Every write is an upsert keyed on URL,
   product name or phase name, so once committed, `pod install` is a no-op on the
   pbxproj — CI's tree-clean diffs are the cross-machine determinism check.
3. Xcode resolves the package graph (13 repositories, 1.2 GB in the clone dir, 437 MB as a CI cache entry:
   841 MB of `binaryTarget` zips it downloads for every artifact in the graph even
   though Messaging builds none of them — grpc-binary alone is 609 MB — plus a 251 MB
   firebase-ios-sdk mirror) and writes
   `ios/OrbitalMobile.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

SPM requires `use_frameworks! :linkage => :dynamic` (firebase-ios-sdk products are
automatic-linkage libraries; RNFB hard-fails on static). The whole pod graph is
therefore dynamic frameworks: 96 pods; a Debug simulator build embeds 96 `.framework`s
(2 before) and grew 80 → 101 MB; FirebaseCore is compiled into RNFBApp, RNFBMessaging
and the app binary separately (RNFB's documented RN ≥ 0.75 default). Firebase/Google
privacy manifests now ship as SPM resource bundles at the app root
(`Firebase_FirebaseCore.bundle/PrivacyInfo.xcprivacy` etc.; 14 observed in the Debug
build) instead of CocoaPods resource bundles.

`OrbitalSignal.podspec` is regenerated byte-for-byte by ubrn on every Rust build
(`ubrn.config.yaml` has no `noOverwrite`): OrbitalSignal's linkage settings have exactly
one legal home, the `missing_links` block in `ios/Podfile` — never the podspec.

### Version record

| What | Value | Where it lives |
|---|---|---|
| `@react-native-firebase/app`, `/messaging` | 26.3.3 | `package.json` / `package-lock.json`; `RNFBApp (26.3.3)` in `ios/Podfile.lock` |
| Firebase iOS SDK | 12.18.0 | **Enforced:** `exactVersion` on the firebase-ios-sdk `XCRemoteSwiftPackageReference` in `ios/OrbitalMobile.xcodeproj/project.pbxproj`, checked by `scripts/verify-firebase-spm.rb` against `sdkVersions.ios.firebase` in the installed RNFB package on every `pod install`; resolved into `Package.resolved` (same script + ci.yml gate) |
| firebase-ios-sdk revision | `346daa9f4631…` (tag 12.18.0) | `Package.resolved` `state.revision`; recorded here so a same-version revision swap is a visible two-file diff. Re-record at every bump. |
| Package URL (supply-chain anchor) | `https://github.com/firebase/firebase-ios-sdk.git` | **Literal** `ORBITAL_FIREBASE_SPM_URL` in `ios/Podfile` (mirrored by the `rnfb-spm-dynamic` invariant); guard 1 requires the installed RNFB's `firebaseSpmUrl` to equal it, the verifier requires the pbxproj reference and the pin `location` to equal it |
| Transitive packages (12) | see `Package.resolved` | each pinned by version **and** commit revision; the verifier requires every `location` to be a `github.com` repo under the firebase / google / googleads orgs (the only orgs the graph uses; grpc-binary and abseil live under google/) |
| Local clone cache | `~/Library/Caches/orbital-spm` (CI + build machine via `-clonedSourcePackagesDirPath`); Xcode GUI uses DerivedData/SourcePackages | CI cache key `spm-<os>-<hash of Package.resolved>` |

RNFB creates the package reference with `upToNextMajorVersion` (floating within 12.x —
the probe resolved 12.19.2 against RNFB's declared 12.18.0). The committed reference is
hand-set to `exactVersion`; RNFB never rewrites an existing reference. `Pods.xcodeproj`
keeps RN's floating requirement; Xcode intersects the two, so the workspace resolves the
exact version (verified). Firebase was already exact-pinned under CocoaPods
(`Firebase/CoreOnly (= 12.18.0)` in the old lock, from RNFB's podspec), so this changes
where the pin lives, not who moves it: Firebase moves when `@react-native-firebase` moves.
Dependabot's `swift` ecosystem can read `Package.resolved`; a Dependabot-authored Firebase
bump would fail the verifier (pbxproj exactVersion ≠ RNFB's declared version) by design —
the RNFB bump procedure below is the only path.

### Provenance policy

Same accept-and-name posture as Sentry. `Package.resolved` records the commit revision of
every package, so a resolved build is reproducible to the commit, which is stronger than a
CocoaPods spec checksum. Clones come from github.com over HTTPS; binary artifacts come from
`dl.google.com` URLs declared in the upstream `Package.swift` with SPM-verified checksums.
Under `-disableAutomaticPackageResolution` nothing re-derives a revision from its tag; the
recorded revision is trusted by diff (and by the row above). CI's `actions/cache` copy of
the clone dir is restored unverified and is never on the release path; all shipped
binaries are built on Alex's Mac mini from its own clone cache.
**Re-verify:** `rm -rf ~/Library/Caches/orbital-spm`, delete `Package.resolved`, re-run the
bootstrap resolve (below) and confirm the file is byte-identical to the committed one.

### Guards

| Guard | Where it runs | What it checks |
|---|---|---|
| Issue #769 `post_install` (guard 1) in `ios/Podfile` | Every machine, every `pod install` | `RNFirebaseSPM.active?`; installed RNFB's package URL equals the Podfile literal; no Firebase/Google pod in the resolved spec set |
| `scripts/verify-firebase-spm.rb` from `post_integrate` (guard 2) | Every machine, every `pod install` (next-run tripwire); harness `scripts/test-verify-firebase-spm.sh` on every PR | Exactly one Swift package reference in the app project, canonical URL, `exactVersion == RNFirebaseSPM.version`; FirebaseCore product dependency on OrbitalMobile; `Package.resolved` exists, firebase-ios-sdk pin = expected version/URL, every pin on an allow-listed github.com org with a revision |
| `Assert Firebase resolves via SPM` + pbxproj diff | `ci.yml` | ≥ 2 SPM log lines (measured 6), no CocoaPods-branch line; `pod install` was a no-op on the committed pbxproj |
| `Assert Package.resolved satisfies the Firebase requirement` | `ci.yml` | `xcodebuild -resolvePackageDependencies -disableAutomaticPackageResolution` exits 0 (fails with 74 on a pin outside the requirement) and leaves `Package.resolved` unchanged |
| Tree-clean diffs | `build.yml` | pbxproj + Podfile.lock byte-identical after a bare `pod install` on a second machine (Xcode 26.x) |
| `rnfb-spm-dynamic`, `ios-cache-parity` in `scripts/check-security-invariants.mjs` | `security.yml` | No `$RNFirebaseDisableSPM`; `use_frameworks! :linkage => :dynamic`; the URL literal; the three cache steps' `path`, `key` and `restore-keys` identical across workflows |

### Bootstrap (first install on a tree with no package reference — only ever needed once, or after deliberately reverting the pbxproj)

RNFB writes the app-project reference only after `post_integrate` returns, so the
verifier cannot pass on that first run. `ORBITAL_SPM_BOOTSTRAP=1 pod install` downgrades
exactly two checks (reference missing, `Package.resolved` missing) to warnings; then hand-set
`exactVersion`, run `xcodebuild -resolvePackageDependencies -workspace OrbitalMobile.xcworkspace
-scheme OrbitalMobile -clonedSourcePackagesDirPath ~/Library/Caches/orbital-spm` (no
`-disableAutomaticPackageResolution` — that flag never writes the file), then two plain
`pod install` runs that must be no-ops. Never set the variable in CI or a shell profile.

### RNFB bump procedure (every `@react-native-firebase/*` bump; Dependabot PRs fail the verifier by design)

1. `npm install` the new versions; read `sdkVersions.ios.firebase` in the new package.
2. Edit the `exactVersion` in `ios/OrbitalMobile.xcodeproj/project.pbxproj` to that value.
3. From the **main checkout**: `cd ios && pod install` (verifier fails on the stale `Package.resolved` — expected), then the resolve command from Bootstrap (without the disable flag), then `pod install` again (now clean).
4. Confirm `firebase_spm.rb` still defines `RNFirebaseSPM` (`.active?`, `.version`, `.url`) and still prints `Using SPM for Firebase dependency resolution`; confirm the `[RNFB]` phase names are unchanged (`git diff` on the pbxproj shows any rename); confirm `RNFIREBASE_SPM_SIGNATURE_FIX_ARTIFACT_NAMES` did not grow (see Accepted risks).
5. Commit `package.json`, `package-lock.json`, `Podfile.lock`, `project.pbxproj`, `Package.resolved`, the harness fixtures, and this table (version + revision rows) together.
6. Watch the first `build.yml` run on main; re-run the #637 push cases on TestFlight for a major bump; re-check the privacy-manifest and `.signature` items below at the next Archive.

### Accepted risks

- **Dynamic linkage everywhere.** 96 embedded frameworks (Debug simulator; 101 MB vs 80 MB). Release-on-device cold-launch time and IPA size are measured against a main baseline at the merge gate with an agreed budget (see the plan / PR). Dylib interposition on jailbroken devices is easier than with a monolithic static binary; the bundle signature still covers every framework.
- **Per-framework private FirebaseCore copies** (RNFBApp, RNFBMessaging, app). RNFB documents this as its supported configuration; the observable symptom would be `Class FIRApp is implemented in both ...` in the device log plus push-token/registration failures — covered by the #637 device gate.
- **RN 0.82.1 podspec gaps** patched in the Podfile (`missing_links` table) until #311 lands RN ≥ 0.83.
- **`[RNFB] Remove duplicate ... signature files` phase** runs `rm -f` on nine binary-xcframework `.signature` names at every build. Messaging links none of those binaries, but Xcode downloads all of them at resolution; whether any is staged into `CONFIGURATION_BUILD_DIR` at Archive is a merge-gate measurement (recorded in the PR), not an assumption. If Analytics, Firestore or any product with a binaryTarget dependency is ever added, this phase becomes an SDK-signature removal on the release path and must be re-evaluated.
- **Privacy manifests** now travel as SPM resource bundles; their presence in the Release archive is a merge-gate check, not an assumption (see the plan's gate list).
- **SPM network dependency:** every fresh clone (new machine, CI cache miss, `rm -rf` of the clone cache) fetches 1.2 GB from github.com and dl.google.com. CocoaPods already required github.com for pod sources; the delta is size, not a new origin.
- **Floating requirement in Pods.xcodeproj** is untracked (gitignored) and re-created each install; it cannot widen the resolved version past the app project's exact pin, and `-disableAutomaticPackageResolution` in both workflows fails loudly if anything tries.
