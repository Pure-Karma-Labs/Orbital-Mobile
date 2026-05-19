---
name: Resolved findings — Phase 1
description: All security findings confirmed fixed during Phase 1 — 19 verified fixes across PRs #41, #45, #47, #50, #51, #69, #83, #84, plus 23 positive verifications in full crypto audit
type: project
---

## Resolved Security Findings (as of 2026-05-18)

### API Layer (PR #41 — REST API integration)
1. **HTTPS enforcement** — `src/services/api/client.ts` asserts `https://` at module load. Hard-fail prevents accidental HTTP.
2. **E2EE DTO naming** — `src/types/api.ts` uses `encryptedTitle`, `encryptedBody`, `titleIv`, `bodyIv` field names. Server never sees plaintext field names.
3. **Error sanitization** — `src/services/api/errors.ts` sets `serverMessage` only when `__DEV__` is true. Production builds expose only user-friendly messages.
4. **403 does NOT clear tokens** — `src/services/api/client.ts` only clears tokens on 401. 403 correctly preserves the session.

### Secure Storage (PR #45 — Keychain/Keystore)
5. **MMKV encryption key from Keychain** — `src/services/secure-storage/encryptionKeys.ts` generates 256-bit CSPRNG key, stores in Keychain with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
6. **Bootstrap race condition** — `index.js` runs `bootstrap()` before `AppRegistry.registerComponent()`. MMKV/DB guaranteed initialized before any component mounts.
7. **Fresh install detection** — `src/services/secure-storage/secureStorage.ts` `clearKeychainIfFreshInstall()` wipes stale iOS Keychain data using NSUserDefaults sentinel.

### iOS Platform (PR #47)
8. **Entitlements wired into Xcode** — `ios/OrbitalMobile/OrbitalMobile.entitlements` sets `NSFileProtectionCompleteUntilFirstUserAuthentication`.

### Android Platform (PR #45)
9. **Data extraction rules** — `android/app/src/main/res/xml/data_extraction_rules.xml` excludes all domains from cloud backup and device transfer.

### SQLCipher (PR #50)
10. **Raw-key hex syntax** — `src/database/connection.ts` uses `x'<hex>'` format, bypassing PBKDF2 since key is already 256-bit CSPRNG.
11. **cipher_memory_security = ON** — Set first, before other PRAGMAs. SQLCipher zero-fills freed memory pages.
12. **DB stays open for process lifetime** — No repeated open/close cycles. `closeDatabase()` is test-teardown only.

### Signal Protocol Stores (PR #51)
13. **TOFU byte comparison** — `src/services/crypto/IdentityKeyStoreImpl.ts` `bytesEqual()` does byte-level comparison for identity key trust decisions.
14. **Transaction wrapping** — `saveIdentity()` uses BEGIN/COMMIT/ROLLBACK for atomic identity key updates.
15. **Zero console.* in crypto code** — Confirmed: no console.log/warn/error in `src/services/crypto/` directory.

### Crypto Hardening (PR #69 — Issues #66, #67)
16. **F-02: hexToUint8Array NaN coercion** — `src/services/crypto/utils.ts` now checks `Number.isNaN(byte)` and throws on invalid hex input. Issue #66 closed.
17. **F-03: BEGIN IMMEDIATE** — `src/services/crypto/keyGenerationService.ts` now uses `BEGIN IMMEDIATE` at all three transaction sites (lines 98, 273, 386). Issue #67 closed.

### Identity Key Migration (PR #83 — Issue #54)
18. **F-01: Identity private key moved to Keychain/Keystore** — Identity key pair now stored in iOS Keychain / Android Keystore with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` accessibility. Cache-on-load pattern avoids repeated Keychain reads. Migration path from SQLCipher items table. Cache cleared on logout. Issue #54 closed.

### PoC Feature Gating (PR #84 — Issue #40)
19. **F-04: PoC/demo functions gated behind Cargo feature flag** — Roundtrip PoC functions now gated behind `dev-roundtrip` Cargo feature flag. Default features = [], so production/release builds exclude PoC code entirely. Issue #40 closed.

### SQLCipher Quoting Bug (commit 5102ac6 — 2026-05-18)
20. **0-byte DB from double-quoted encryption key** — op-sqlite's C++ bridge wraps `encryptionKey` in single quotes (`PRAGMA key = '<key>'`). Our code passed `x'<hex>'`, producing `PRAGMA key = 'x'<hex>''` — broken quoting. DB appeared to work in-memory but never persisted (0 bytes, no WAL/SHM). Fix: pass raw hex string, let op-sqlite wrap it. SQLCipher uses PBKDF2 derivation in passphrase mode. File: `src/database/connection.ts:25`.

### Attachment Key Distribution (commit 8430083 — 2026-05-18)
21. **#122: attachment_key BLOB alignment + envelope distribution** — attachment_key was stored as base64 TEXT in BLOB column and was only in local SQLCipher (lost on fresh install). Fix: embed attachment_key (base64, 64 bytes decoded) inside AES-256-GCM encrypted metadata envelope with `v: 1` versioning. `normalizeAttachmentKey()` handles legacy Uint8Array, ArrayBuffer, and string types. Zero-knowledge preserved — keys inside group-key-encrypted envelope.

### processedMediaIds Logout Clearing (commit associated with 2026-05-18)
22. **Stale dedup set on logout** — Module-level `Set<string>` in `threadService.ts` was never cleared on logout. `clearProcessedMediaIds()` now exported and called from `authService.ts` logout alongside `clearGroupKeyCache()`.

### Full Phase 1 Audit (docs/security-audit-phase1.md)
- 14 findings documented (F-01 through F-14)
- 23 positive verifications across crypto pipeline, key storage, platform configs
- Phase 1 assessed as **architecturally sound** for an E2EE messaging foundation
- **All Critical and High findings now resolved** — clean for Phase 2

**Why:** Tracking resolved findings prevents re-auditing and documents security posture improvement. The Phase 1 audit report at `docs/security-audit-phase1.md` is the canonical reference.
**How to apply:** When reviewing future PRs touching these files, verify these properties are preserved. Any regression is Critical severity.
