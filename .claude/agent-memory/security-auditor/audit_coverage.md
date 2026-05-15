---
name: Audit coverage — Phase 1 complete, Phase 2 started
description: Phase 1 complete (2026-04-09), Phase 2 attachment crypto reviewed (2026-05-14) — 12 PRs reviewed, 14+5 findings, 33 positive verifications
metadata:
  type: project
---

## Audit Coverage — Phase 1 Complete (2026-04-09)

### PRs Reviewed
| PR | Scope | Findings | Status |
|----|-------|----------|--------|
| #41 | REST API layer (client, auth, errors, types) | 4 verified fixes | Merged |
| #45 | Secure storage (MMKV, Keychain, bootstrap, Android backup) | 4 verified fixes | Merged |
| #47 | iOS entitlements (file protection, Keychain groups) | 1 verified fix | Merged |
| #50 | SQLCipher connection (raw-key, PRAGMAs, WAL) | 3 verified fixes | Merged |
| #51 | Signal Protocol stores (identity, session, pre-key, sender-key) | 3 verified fixes + Issue #54 filed | Merged |
| #69 | Crypto hardening (hexToUint8Array NaN, BEGIN IMMEDIATE) | 2 fixes (Issues #66, #67 closed) | Merged |
| #83 | Identity key migration to Keychain/Keystore | F-01 Critical resolved (#54 closed) | Merged |
| #84 | PoC feature-flag gating | F-04 High resolved (#40 closed) | Merged |

### Full Phase 1 Audit Report
- Location: `docs/security-audit-phase1.md`
- 14 findings (F-01 through F-14): 1 Critical, 3 High, 4 Medium, 4 Low, 2 Info
- 23 positive verifications documenting correct security patterns
- Overall assessment: **Architecturally sound** for an E2EE messaging foundation
- **All Critical and High findings now resolved** — clean for Phase 2

### Findings Resolution Summary
| Finding | Severity | Status |
|---------|----------|--------|
| F-01 Identity key in SQLCipher | Critical | **RESOLVED** (PR #83, #54 closed) |
| F-02 hexToUint8Array NaN | High | **RESOLVED** (PR #69, #66 closed) |
| F-03 BEGIN IMMEDIATE | High | **RESOLVED** (PR #69, #67 closed) |
| F-04 PoC in prod binary | High | **RESOLVED** (PR #84, #40 closed) |
| F-05 Deprecated store BEGIN TRANSACTION | Medium | Superseded by F-03 fix |
| F-06 bytesEqual not constant-time | Medium | Open (Phase 2) |
| F-07 store_adapters.rs dead code | Medium | Tracked |
| F-08 authService console.warn | Medium | Tracked |
| F-09 orbital:// URL scheme | Medium | Open (Phase 3) |
| F-10 No cert pinning | Low | Open (Phase 2) |
| F-11 No jailbreak detection | Low | Open (Phase 2) |
| F-12 No biometric gating | Low | Open (Phase 2) |
| F-13 usesCleartextTraffic | Low | Tracked |
| F-14 npm audit vulnerabilities | Info | Tracked |

### OWASP Mobile Top 10 — Phase 1 Final Status
| Category | Status | Notes |
|----------|--------|-------|
| M1 Improper Platform Usage | Partial | Entitlements correct; URL scheme needs Universal Links (Phase 3) |
| M2 Insecure Data Storage | **PASS** | MMKV encrypted, SQLCipher configured, identity key in Keychain with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (PR #83) |
| M3 Insecure Communication | Partial | HTTPS enforced; cert pinning deferred (Phase 2) |
| M4 Insecure Authentication | PASS | JWT refresh on 401, 403 preserves session, token in Keychain |
| M5 Insufficient Cryptography | PASS | AES-256, CSPRNG keys, per-field IVs, cipher_memory_security ON |
| M6 Insecure Authorization | Not assessed | Server-side authorization not yet audited |
| M7 Client Code Quality | PASS | TypeScript strict, no console.* in crypto, error sanitization |
| M8 Code Tampering | Not assessed | Jailbreak/root detection not yet implemented |
| M9 Reverse Engineering | Partial | PoC functions excluded from release (PR #84); no obfuscation assessment |
| M10 Extraneous Functionality | **PASS** | PoC gated behind `dev-roundtrip` feature flag, excluded from default builds (PR #84) |

### Crypto Pipeline Coverage — Phase 1
- **Key generation:** CSPRNG via platform APIs — verified
- **Key storage:** Identity key in Keychain/Keystore (PR #83), other keys in SQLCipher BLOB columns — verified
- **Session management:** Double Ratchet store with transaction wrapping — verified
- **TOFU:** Byte-level comparison with trust-on-first-use — verified
- **Pre-key management:** Batch generation, replenishment, signed key rotation — verified
- **Kyber (PQC):** Last-resort pre-key generated and uploaded — verified
- **Group messaging:** Sender Key store schema present, distribution not yet implemented
- **Sealed Sender:** Not yet implemented

### Established Security Patterns
These patterns were validated during Phase 1 and must be preserved:

1. **`BEGIN IMMEDIATE` for all crypto transactions** — not `BEGIN TRANSACTION` (prevents TOCTOU races)
2. **Per-address lock map for operation serialization** — prevents concurrent ratchet operations on same session
3. **No private key material in FFI Result types** — only public keys cross the Rust/TS boundary in results
4. **No console.log in crypto code paths** — enforced across `src/services/crypto/`
5. **Pre-key consumption atomicity** — session save + identity check + key deletion in single `BEGIN IMMEDIATE` transaction
6. **Identity key in Keychain/Keystore** — cache-on-load pattern, cache cleared on logout, migration from SQLCipher

---

## Phase 2 — Attachment Crypto & Media Pipeline (2026-05-14)

### New PRs/Commits Reviewed
| Commit/PR | Scope | Findings | Status |
|-----------|-------|----------|--------|
| #113 | Media system foundation: attachment crypto, API client, repository, store | Schema/pattern verified | Merged |
| #117 | Media upload pipeline + picker integration (Chunk 2) | Temp file cleanup, DB guard verified | Merged |
| #121 | Media picker for ReplyComposer | Permission strings verified | Merged |
| #124 | Regenerate native bindings for attachment crypto | FFI boundary verified | Merged |

### Positive Verifications (Attachment Crypto)
1. **HMAC-before-decrypt** — `attachment_crypto.rs:145-157` verifies HMAC before CBC decryption
2. **Opaque error messages** — All failure paths return `SignalError::InvalidMessage { reason: "decryption failed" }`
3. **CSPRNG IV** — `rand::fill()` for 16-byte IV generation (OS CSPRNG)
4. **64-byte key enforcement** — Both encrypt and decrypt reject keys != 64 bytes
5. **Digest verification** — SHA-256 of ciphertext verified before decrypt
6. **plaintextHash not sent** — `mediaUploadService.ts:310` discards hash with `void plaintextHash`
7. **Temp file cleanup** — `finally` blocks delete chunk files; `cleanupOrphanedChunks()` runs at bootstrap via lazy import
8. **iOS file protection** — `CachesDirectoryPath` inherits `NSFileProtectionCompleteUntilFirstUserAuthentication` from entitlements
9. **DB guard for Metro** — `saveMedia` and `setGroupMasterKey` wrapped in try/catch; non-fatal in dev only
10. **Info.plist permissions** — `NSPhotoLibraryUsageDescription` and `NSCameraUsageDescription` present with appropriate descriptions

### Backend Security Notes (not findings)
- `completeUpload` fixed: now uses client's `media_id` (was generating new UUID causing 404)
- Rate limit raised 100→500 req/15min; per-endpoint limits deferred (follow-up issue filed)

**Why:** Tracking audit coverage prevents re-work and provides a Phase 1 baseline for measuring Phase 2+ security posture changes.
**How to apply:** Use this as a checklist when scoping future audits. Prioritize "Not assessed" OWASP categories. Verify established patterns are not regressed by new code.
