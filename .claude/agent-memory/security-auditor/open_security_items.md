---
name: Open security items
description: Tracked security items not yet resolved — 0 Critical/High remaining; 11 Medium/Low items across Phase 1, Phase 2, and Media Chunk 3
metadata:
  type: project
---

## Open Security Items (as of 2026-05-14)

### Critical / High — NONE REMAINING
All Critical and High findings resolved. Security audit status is clean.

- F-01 (Critical): Resolved in PR #83 — identity key moved to Keychain/Keystore
- F-04 (High): Resolved in PR #84 — PoC gated behind `dev-roundtrip` Cargo feature flag

### Medium (Phase 2-3)

1. **F-09: `orbital://` custom URL scheme hijackable on both iOS and Android**
   - Location: `ios/OrbitalMobile/Info.plist` CFBundleURLSchemes, Android intent-filter
   - Remediation: Phase 3 — migrate to Universal Links (iOS) / App Links (Android) with verified domain association

2. **F-06: `bytesEqual` in utils.ts uses early-return comparison (not constant-time)**
   - Location: `src/services/crypto/utils.ts:5-10`
   - Risk: Timing side-channel on identity key comparison. Low practical risk in JS (timing noise), but violates crypto best practice.
   - Remediation: Accumulate XOR differences, return equality of accumulator

### Low (Phase 2)

3. **F-10: No certificate pinning for `api.orbitl.org`**
   - Location: `src/services/api/client.ts`, WebSocket connection setup
   - Remediation: Phase 2 — TrustKit (iOS) / OkHttp CertificatePinner (Android)

4. **F-11: No jailbreak/root detection**
   - OWASP: M8 (Code Tampering)
   - Remediation: Phase 2

5. **F-12: No biometric gating for Keychain/Keystore access**
   - Location: `src/services/secure-storage/encryptionKeys.ts`
   - OWASP: M2 (Insecure Data Storage)
   - Remediation: Phase 2 — `kSecAccessControlBiometryCurrentSet` / `setUserAuthenticationRequired(true)`

6. **F-13: `usesCleartextTraffic` uses build variable, not hardcoded false for release**
   - Location: `android/app/src/main/AndroidManifest.xml`
   - Remediation: Hardcode `false` in release build type

### Info

7. **F-14: npm audit: 6 vulnerabilities (3 high, 1 moderate in dev dependencies)**
   - Remediation: Periodic `npm audit fix`; monitor for production dependency vulnerabilities

---

### Phase 2 — New (as of 2026-05-14)

1. **#114: Key zeroization not implemented (Medium)**
   - Location: `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs`
   - `keys` param is `Vec<u8>`, not wrapped in `zeroize::Zeroizing<Vec<u8>>`
   - `AttachmentCryptoResult.plaintext_hash` and intermediate key slices not zeroized on drop
   - `Zeroizing` crate not in Cargo.toml dependencies
   - Remediation: Add `zeroize` dependency, wrap `keys` and sensitive intermediates in `Zeroizing`

2. **#115: plaintextHash branded type guard (Low)**
   - Location: `src/services/crypto/attachmentCrypto.ts:81`
   - `plaintextHash` is currently a plain `string` — no compile-time guard preventing accidental inclusion in API payloads
   - Remediation: Create a branded type (`type PlaintextHash = string & { __brand: 'PlaintextHash' }`) to catch accidental serialization at compile time

3. **#122: attachment_key stored as base64 TEXT in BLOB column (Low)**
   - Location: `src/services/mediaUploadService.ts:379` (`buildMediaRow` passes `keysBase64` string)
   - Schema at `src/database/migrations/001_initial_schema.ts:154` declares `attachment_key BLOB`
   - SQLite silently accepts TEXT into BLOB columns, so it works at runtime, but defeats the column intent and breaks the `blob-for-keys` pattern
   - Remediation: Store raw `Uint8Array` keys instead of base64, or change schema to TEXT if BLOB is not needed

4. **No FFI boundary integration test (Low)**
   - The Rust `attachment_crypto.rs` has unit tests, and Jest tests mock the FFI boundary
   - No on-device roundtrip test (encrypt in Rust via FFI → decrypt in Rust via FFI) exercising the actual uniffi binding layer
   - Remediation: Add a Detox or manual integration test that calls `encryptAttachment` → `decryptAttachment` on a real device

5. **No AbortController wired on component unmount (Low)**
   - Location: `src/screens/ComposeThreadScreen.tsx:67`, `src/screens/ThreadDetailScreen.tsx:313`
   - `uploadMedia` accepts `AbortSignal` but callers don't create an `AbortController`
   - If user navigates away during upload, the upload continues in the background (wasted bandwidth, orphaned server-side upload state)
   - Remediation: Create `AbortController` in the upload handler, wire to `useEffect` cleanup

6. **Per-file NSURLIsExcludedFromBackupKey needs native bridge (Low)**
   - Location: `src/services/mediaUploadService.ts:293` (TODO(F2)), `src/services/mediaDownloadService.ts:103` (TODO(F2))
   - Directory-level `mkdir({ NSURLIsExcludedFromBackupKey: true })` does not reliably propagate to children on all iOS versions
   - Currently used as best-effort in both upload and download services
   - Remediation: Build a thin native bridge to call `NSURL.setResourceValue(_:forKey:.isExcludedFromBackupKey)` per-file after write; or use a community RN module that exposes this API
   - Risk: Without per-file exclusion, iOS may include decrypted media files in iCloud/iTunes backups on some OS versions. Mitigated by app-level `NSFileProtectionCompleteUntilFirstUserAuthentication` and the data extraction rules for Android.

**Why:** Tracking open items ensures nothing is forgotten between sessions and provides priority ordering for implementation agents.
**How to apply:** Reference this list when reviewing PRs that touch these areas. No items currently block beta release. Medium/Low items are scheduled for their noted phases.
