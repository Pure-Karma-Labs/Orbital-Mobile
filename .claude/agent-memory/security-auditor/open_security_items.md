---
name: Open security items
description: Tracked security items not yet resolved — 0 Critical/High remaining; 5 Medium/Low deferred to Phase 2-3
type: project
---

## Open Security Items (as of 2026-04-09)

### Critical / High — NONE REMAINING
All Critical and High findings resolved. Security audit status is clean for Phase 2.

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

**Why:** Tracking open items ensures nothing is forgotten between sessions and provides priority ordering for implementation agents.
**How to apply:** Reference this list when reviewing PRs that touch these areas. No items currently block beta release. Medium/Low items are scheduled for their noted phases.
