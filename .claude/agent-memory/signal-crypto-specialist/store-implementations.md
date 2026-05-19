---
name: store-implementations
description: 6 TS store classes (PR #51) now serve as orchestration layer for preloaded store pattern; cryptoService.ts is the primary consumer; identity key migrated to Keychain/Keystore (Issue #54 resolved)
metadata:
  type: project
---

PR #51 merged 2026-04-08. Six store classes in `src/services/crypto/` backed by SQLCipher repositories in `src/database/repositories/`.

**Role:** These stores are the **orchestration layer** for the preloaded store pattern. They are NOT uniffi callback interfaces (FfiConverterArc blocker). Instead, `cryptoService.ts` calls the repository functions directly to read store data into Input records and persist Result records back.

**cryptoService.ts (added 2026-04-09):** The primary consumer of the Rust functions. Imports directly from `orbital-signal` and from `../../database/repositories/*`. The 6 store classes remain as encapsulation around SQLCipher access but the crypto service bypasses them for the preloaded pattern, going directly to repository functions.

**Identity key storage (Issue #54 -- RESOLVED):** Private identity key is now stored in OS Keychain (iOS) / Keystore (Android) via `react-native-keychain`, with a module-scoped cache variable in `keyGenerationService.ts`. Migration from SQLCipher is automatic and one-way: on first access, if the key exists in SQLCipher but not Keychain, it is written to Keychain and removed from SQLCipher. Public key remains in the items table for convenience (it is not secret).

**TOFU trust logic and identity change handling:** `isTrustedIdentity` returns true if no existing identity (trust on first use) or if the stored identity matches byte-for-byte. When Rust returns `identityChanged: true`, cryptoService.ts sets `VerifiedStatus.Unverified` (not `Default`). `Default` = never seen; `Unverified` = identity changed and not yet re-verified by the user. This mapping is applied in both `decryptPreKeyMessage` and `establishSession` code paths. See [[libsignal-api-learnings]] for the asymmetric pre-load constraint that governs when `identityChanged` can actually fire.

**KyberPreKey markUsed semantics:** One-time keys (is_last_resort = 0) are deleted after use. Last-resort keys (is_last_resort = 1) are retained (no-op).

**ArrayBuffer/Uint8Array boundary:** `cryptoService.ts` uses `toArrayBuffer()` from `./utils` to convert Uint8Array to ArrayBuffer for uniffi Record fields. The `hexToUint8Array` and `base64ToArrayBuffer` helpers handle format conversion from storage and API responses respectively.

**Pre-key bundle fetching:** `getPreKeyBundle(serviceId)` in `src/services/api/keys.ts` fetches a remote user's pre-key bundle for session establishment. `bundleResponseToData()` in cryptoService.ts converts the API response to the `PreKeyBundleData` uniffi Record format.

**Why:** These stores + cryptoService.ts form the complete TypeScript side of the Signal Protocol pipeline.

**How to apply:** When adding new protocol operations (e.g., sealed sender), follow the pattern in cryptoService.ts: read store data via repository functions, pack into Input record, call Rust, persist Result in a BEGIN IMMEDIATE transaction, wrap in withAddressLock.
