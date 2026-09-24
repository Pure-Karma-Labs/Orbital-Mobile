# Phase 1 Crypto Security Audit Report -- Orbital-Mobile

> **Status refresh:** 2026-07-01 -- all finding statuses verified against current codebase and git history. This document is a point-in-time Phase 1 audit retained for transparency; it does not cover Phase 2 features (ECIES wrapping, attachment crypto, push notifications, media pipelines) which were audited separately.

**Auditor:** Security Auditor Agent
**Date:** 2026-04-09 (original audit)
**Scope:** All cryptographic code implemented in Phase 1 (Rust crate, TypeScript crypto layer, secure storage, database, platform configs)

---

## Summary Table of Findings

| # | Finding | Severity | Category | Status |
|---|---------|----------|----------|--------|
| F-01 | Identity private key stored as hex TEXT in items table, not in Keychain/Keystore | **Critical** | OWASP M2 / Crypto | Resolved (PR #83) |
| F-02 | `hexToUint8Array` silently converts invalid hex to zero bytes (NaN coercion) | **High** | Crypto / Input Validation | Resolved (PR #69) |
| F-03 | `keyGenerationService.ts` uses `BEGIN TRANSACTION` instead of `BEGIN IMMEDIATE` | **High** | Crypto / Atomicity | Resolved (PR #69) |
| F-04 | PoC roundtrip functions exported in production binary | **High** | OWASP M10 | Resolved (PR #84) |
| F-05 | Deprecated IdentityKeyStoreImpl uses `BEGIN TRANSACTION` instead of `BEGIN IMMEDIATE` | **Medium** | Crypto / Atomicity | Resolved (PR #75) |
| F-06 | `bytesEqual` in utils.ts uses early-return comparison (not constant-time) | **Medium** | Crypto | Open (no tracking issue) |
| F-07 | `store_adapters.rs` dead code compiled and exported via `pub use` | **Medium** | OWASP M9 | Resolved (PR #75) |
| F-08 | `authService.ts` logs key generation errors to console.warn in production | **Medium** | OWASP M7 | Resolved (multiple PRs) |
| F-09 | `orbital://` custom URL scheme hijackable on both iOS and Android | **Medium** | OWASP M1 | Open (no tracking issue) |
| F-10 | No certificate pinning for `api.orbitl.org` | **Low** | OWASP M3 | Open (Issue #174) |
| F-11 | No jailbreak/root detection | **Low** | OWASP M8 | Open (Issue #177) |
| F-12 | No biometric gating for Keychain/Keystore access | **Low** | OWASP M2 | Open (Issue #175) |
| F-13 | `usesCleartextTraffic` uses build variable, not hardcoded false for release | **Low** | OWASP M3 | Resolved (by design) |
| F-14 | npm audit: 6 vulnerabilities (3 high, 1 moderate in dev dependencies) | **Info** | Dependencies | Superseded by CI |

**Resolution summary:** 9 resolved, 5 open (0 Critical, 0 High, 2 Medium, 3 Low).

---

## Resolved Findings (Critical/High)

### F-01: Identity private key stored as hex TEXT in items table

**Severity:** Critical
**Location:** `src/services/crypto/keyGenerationService.ts`, `src/services/crypto/cryptoService.ts`
**Status:** Resolved -- PR #83 (commit 89fb310), Issue #54 closed.

**Resolution:** Identity private key migrated from SQLCipher `items` table to iOS Keychain / Android Keystore via `setSecureItem` / `getSecureItem`. Cache-on-load pattern keeps the key in memory for session duration. Automatic migration path reads from DB, writes to Keychain, then deletes the DB copy. Logout clears the in-memory cache via `removeSecureItem`.

### F-02: hexToUint8Array silently converts invalid hex to zero bytes

**Severity:** High
**Location:** `src/services/crypto/utils.ts:hexToUint8Array`
**Status:** Resolved -- PR #69 (commit bdb9b7c).

**Resolution:** Added `Number.isNaN(byte)` check after `parseInt` -- now throws `Error('Invalid hex character at position ...')`. Also validates odd-length hex strings.

### F-03: keyGenerationService uses BEGIN TRANSACTION instead of BEGIN IMMEDIATE

**Severity:** High
**Location:** `src/services/crypto/keyGenerationService.ts`
**Status:** Resolved -- PR #69 (commit bdb9b7c).

**Resolution:** All three transaction sites (lines 141, 315, 428) now use `BEGIN IMMEDIATE`, preventing concurrent read-then-write interleaving.

### F-04: PoC roundtrip functions exported in production binary

**Severity:** High
**Location:** `packages/orbital-signal/rust/orbital_signal/src/roundtrip.rs`, `lib.rs`
**Status:** Resolved -- PR #84 (commit 194c975), Issue #40 closed.

**Resolution:** Roundtrip module gated behind `#[cfg(feature = "dev-roundtrip")]`. Default features are empty (`default = []`), so release builds exclude the PoC functions entirely. CI security workflow runs tests with `--features dev-roundtrip` to maintain coverage.

---

## Resolved Findings (Medium/Low)

### F-05: Deprecated IdentityKeyStoreImpl uses BEGIN TRANSACTION

**Severity:** Medium
**Status:** Resolved -- PR #75 (commit b6be5dc).

**Resolution:** `IdentityKeyStoreImpl.ts` file deleted entirely as part of the batch cleanup that removed dead store implementations.

### F-07: store_adapters.rs dead code compiled and exported via pub use

**Severity:** Medium
**Status:** Resolved -- PR #75 (commit b6be5dc).

**Resolution:** Dead store adapter trait implementations deleted. The remaining `store_adapters.rs` is a private crate module (`mod store_adapters`, not `pub use`) containing only the `to_protocol_address` helper, which is actively used by `group.rs` (4 call sites) and `session.rs` (5 call sites). No dead code is exported through the public API.

### F-08: authService.ts logs key generation errors to console.warn in production

**Severity:** Medium
**Status:** Resolved -- established incrementally across multiple PRs (pattern present since PR #90, maintained through PRs #255, #345, #389, #444).

**Resolution:** All console.warn calls in `authService.ts` are now gated with `if (__DEV__)`. Current file has 17 such guarded statements. The Semgrep rule `no-console-in-crypto` in `.github/semgrep-rules/orbital-mobile.yml` enforces this invariant in CI for crypto/security/database paths.

### F-13: usesCleartextTraffic uses build variable, not hardcoded false for release

**Severity:** Low
**Status:** Resolved (by design -- React Native framework behavior).

**Resolution:** The `${usesCleartextTraffic}` manifest placeholder is set by the React Native Gradle plugin (`@react-native/gradle-plugin` `AgpConfiguratorUtils.kt`), which automatically sets it to `false` for release build types and `true` only for debug variants. This is the correct, framework-standard approach in RN 0.82+.

### F-14: npm audit vulnerabilities

**Severity:** Info
**Status:** Superseded by automated CI security workflow.

**Resolution:** The CI security pipeline (`.github/workflows/security.yml`) runs `npm audit` on every PR (gating on critical-severity) and a full weekly audit report. As of 2026-07-01, production dependencies show 14 advisories (13 moderate, 1 high) -- all in transitive React Native ecosystem dependencies with no reachable attack surface in the app. The weekly report surfaces these for human triage.

---

## Sentry Payload Guards (#746)

**Location:** `src/sentryInit.ts`, `src/services/telemetry.ts`, `src/services/telemetryScrub.ts`, `src/App.tsx`
**Status:** Post-audit hardening -- extends the "no user content in diagnostics" posture of F-08 from console logging to the crash-reporting channel.

Crash reporting is the one path on which a failure leaves the device for a server the developer does not control, so the payload is constrained by a single global boundary rather than by call-site discipline.

- **One capture path.** Every caught error reaches Sentry through `captureError()` in `src/services/telemetry.ts`, which reports a rebuilt `Error` -- class name, scrubbed message, scrubbed stack frames -- instead of the thrower's own object. Custom fields (`ApiError.serverMessage`, `QuotaExceededError.usage`) therefore cannot be serialized into the event.
- **Breadcrumb drops.** `beforeBreadcrumb` (`filterBreadcrumb`) drops every `http`-type crumb and the `touch`, `ui.multiClick` and `console` categories, and rebuilds the surviving crumb's `data` from primitives only. `touch` / `ui.multiClick` crumbs come from `Sentry.wrap`'s TouchEventBoundary and carry the pressed element's accessibility label or rendered text, several of which interpolate decrypted content. Console capture is additionally off at source (`breadcrumbsIntegration({ console: false })`), and `Sentry.wrap(App, { touchEventBoundaryProps: { extractTextFromChildren: false, enableRageTapDetection: false } })` is the secondary touch-label defence.
- **`beforeSend` re-filters.** `scrubEvent` scrubs exception values, `message` / `logentry`, `extra` and `tags`, and runs the breadcrumb filter a second time. The second pass is required, not belt-and-braces: `deviceContextIntegration` merges the native breadcrumb buffer into the event inside an event processor (concat, sort by timestamp, slice to `maxBreadcrumbs`), which runs after `beforeBreadcrumb` and before `beforeSend`, so native crumbs never pass through the first hook at all.
- **Native network breadcrumbs off.** `enableNetworkBreadcrumbs: false` stops sentry-cocoa swizzling `NSURLSession`. The JS hooks cannot cover this: `initNativeSdk` strips `beforeSend` and `beforeBreadcrumb` from the options it forwards to native, so a hard native crash report is assembled by sentry-cocoa with no JS boundary in the path, and request URLs -- orbit, thread and media UUIDs, attributable through `setUser({ id })` -- would ship inside it. The re-check triggers for an SDK bump are in `docs/ios-dependency-delivery.md`.

**Enforcement.** Four layers, all in CI: the Semgrep rule `no-raw-sentry-capture` in `.github/semgrep-rules/orbital-mobile.yml` is severity ERROR and the scan runs with `--severity ERROR --error`, so any `captureException` / `captureEvent` outside `src/services/telemetry.ts` fails the job; `.eslintrc.js` bans `@sentry/*` and the telemetry facades from crypto, secure-storage and database paths (the pure `telemetryScrub.ts` stays allowed); section 15 (`sentry-privacy-hooks`) of `scripts/check-security-invariants.mjs`, run by the Security Invariants job of `.github/workflows/security.yml`, pins the four cross-file facts a unit test cannot observe -- the `Sentry.init()` options literal (both hooks, `enableNetworkBreadcrumbs: false`, `console: false`, `sendDefaultPii: false`, `enableMemoryIntrospection: false`, `maxBreadcrumbs`), the `filterBreadcrumb` drop block, the `captureError` body and the `Sentry.wrap(App, ...)` props -- matching inside a located window with comment lines stripped, so a pin that survives only in a comment does not satisfy the rule; and Jest pins the privacy-relevant init options (`__tests__/sentryInit.test.ts`) and the scrub primitives (telemetry tests under `src/services/__tests__/`).

---

## Open Findings

### F-06: bytesEqual not constant-time

**Severity:** Medium
**Category:** Crypto
**Location:** `src/services/crypto/utils.ts:bytesEqual`
**Status:** Open -- no tracking issue filed.

`bytesEqual` uses early-return comparison (`if (a[i] !== b[i]) return false`), not constant-time XOR accumulation. Current usage is limited to identity key comparison in `identityKeyAccess.ts:126` (TOFU verification), where timing side-channel risk is low. However, best practice for cryptographic byte comparison is constant-time regardless of context. Recommended fix: XOR accumulation pattern.

### F-09: orbital:// custom URL scheme hijackable

**Severity:** Medium
**Category:** OWASP M1 -- Improper Platform Usage
**Location:** `ios/OrbitalMobile/Info.plist` (CFBundleURLSchemes), `android/app/src/main/AndroidManifest.xml` (android:scheme="orbital")
**Status:** Open -- no tracking issue filed.

Custom URL schemes can be registered by any app on the device. A malicious app registering `orbital://` could intercept deep links. Mitigation options: migrate to Universal Links (iOS) / App Links (Android) with domain verification, or validate deep link origin. The app's `navigateFromNotification` handler uses a hardcoded type switch that limits navigation to known screens, reducing (but not eliminating) the attack surface.

### F-10: No certificate pinning for api.orbitl.org

**Severity:** Low
**Category:** OWASP M3 -- Insecure Communication
**Status:** Open -- tracked as Issue #174.

No TLS certificate pinning is implemented for API or WebSocket connections. Transport security relies on OS-level certificate validation. Defense-in-depth measure for post-launch hardening.

### F-11: No jailbreak/root detection

**Severity:** Low
**Category:** OWASP M8 -- Code Tampering
**Status:** Open -- tracked as Issue #177.

No app-level jailbreak or root detection. The app relies on Keychain/Keystore access controls and SQLCipher encryption for data-at-rest protection, which remain effective on compromised devices. A detection warning (not block) is recommended for post-launch.

### F-12: No biometric gating for Keychain/Keystore access

**Severity:** Low
**Category:** OWASP M2 -- Insecure Data Storage
**Status:** Open -- tracked as Issue #175.

Keychain items use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` accessibility but do not require biometric authentication for access. The `secureStorage.ts` type signature includes an unused `biometricProtected?: boolean` parameter. This is an optional hardening feature for post-launch.

---

## Positive Findings (23 items verified correct)

- CSPRNG throughout (Rust + TypeScript)
- Zero `unsafe` blocks in Rust
- No private keys in FFI Result types
- Correct libsignal API usage
- PQXDH enforcement (rejects non-Kyber bundles)
- Sealed sender stubs return errors (not empty data)
- Transaction wrapping in cryptoService with `BEGIN IMMEDIATE`
- Per-address operation locking
- SQLCipher configuration (cipher_memory_security, WAL)
- BLOB columns for key material
- Correct Keychain accessibility level
- Fresh install detection
- Android backup exclusion
- iOS ATS enforcement
- Bootstrap ordering guarantee
- Pre-key consumption atomicity
- Pre-key ID parsing before store reads
- Kyber last-resort key generated
- Comprehensive error mapping
- No console.log in crypto code
- 7-day signed pre-key rotation
- Pre-key replenishment at threshold

---

## Phase 2 Readiness

**The Phase 1 crypto foundation is architecturally sound. All Critical and High findings have been resolved. The remaining 5 open items (2 Medium, 3 Low) are defense-in-depth measures tracked for post-launch hardening.**
