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

## Guards

| Guard | Where it runs | What it checks |
|---|---|---|
| Issue #768 `post_install` in `ios/Podfile` | Every machine, every `pod install` | Staged version set equals `expected_sentry_cocoa`; symlink exists and `Info.plist` is reachable through it; `$(PODS_ROOT)` reference present in `RNSentry.podspec.json`; then runs `scripts/assert-no-absolute-pod-paths.sh` |
| `scripts/assert-no-absolute-pod-paths.sh` | `ci.yml` after `pod install --deployment` (incl. after a failed `--deployment`); `build.yml` after bare `pod install` | No `/Users/`, `/Library/Caches/`, or quoted absolute `FRAMEWORK_SEARCH_PATHS` in `Pods/Local Podspecs/*.json` or `Pods/Target Support Files/**/*.xcconfig` |
| `pod install --deployment` + tree-clean diff | `ci.yml` | Lock drift — fails if `Podfile.lock` changes after a deployment install |

**Never set `SENTRY_USE_XCFRAMEWORK=0`** (in `ios/Podfile` or your shell). The
Podfile opt-out was removed in #768; `@sentry/react-native` ≥ 8.23 raises on
it, and the Issue #768 `post_install` guard fails without the staged xcframework.

---

## Re-check trigger

Any `@sentry/react-native` bump (next: #743, targets ≥ 8.23 / sentry-cocoa 9.24):

1. Confirm `stage_sentry_xcframework_in_pods` still returns a
   `$(PODS_ROOT)/sentry-xcframeworks/...` path.
2. Confirm the checksum table in `sentry_utils.rb` has the new version.
3. Bump `expected_sentry_cocoa` in `ios/Podfile`.
4. Run `pod install` from the **main checkout** (not a worktree — worktree
   installs poison the ReactCodegen SPEC CHECKSUM).
5. Update the Version record table above.

---

## Firebase

Pending #769 (SPM migration before Firebase stops publishing pods, October 2026).
