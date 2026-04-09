# Phase 1 Crypto Security Audit Report — Orbital-Mobile

**Auditor:** Security Auditor Agent
**Date:** 2026-04-09
**Scope:** All cryptographic code implemented in Phase 1 (Rust crate, TypeScript crypto layer, secure storage, database, platform configs)

---

## Summary Table of Findings

| # | Finding | Severity | Category | Status |
|---|---------|----------|----------|--------|
| F-01 | Identity private key stored as hex TEXT in items table, not in Keychain/Keystore | **Critical** | OWASP M2 / Crypto | Open (Issue #54) |
| F-02 | `hexToUint8Array` silently converts invalid hex to zero bytes (NaN coercion) | **High** | Crypto / Input Validation | New |
| F-03 | `keyGenerationService.ts` uses `BEGIN TRANSACTION` instead of `BEGIN IMMEDIATE` | **High** | Crypto / Atomicity | New |
| F-04 | PoC roundtrip functions exported in production binary | **High** | OWASP M10 | Open (Issue #40) |
| F-05 | Deprecated IdentityKeyStoreImpl uses `BEGIN TRANSACTION` instead of `BEGIN IMMEDIATE` | **Medium** | Crypto / Atomicity | New |
| F-06 | `bytesEqual` in utils.ts uses early-return comparison (not constant-time) | **Medium** | Crypto | New |
| F-07 | `store_adapters.rs` dead code compiled and exported via `pub use` | **Medium** | OWASP M9 | New |
| F-08 | `authService.ts` logs key generation errors to console.warn in production | **Medium** | OWASP M7 | New |
| F-09 | `orbital://` custom URL scheme hijackable on both iOS and Android | **Medium** | OWASP M1 | Open |
| F-10 | No certificate pinning for `api.orbitl.org` | **Low** | OWASP M3 | Open |
| F-11 | No jailbreak/root detection | **Low** | OWASP M8 | Open |
| F-12 | No biometric gating for Keychain/Keystore access | **Low** | OWASP M2 | Open |
| F-13 | `usesCleartextTraffic` uses build variable, not hardcoded false for release | **Low** | OWASP M3 | New |
| F-14 | npm audit: 6 vulnerabilities (3 high, 1 moderate in dev dependencies) | **Info** | Dependencies | New |

---

## Must-Fix Before Beta Release (Critical/High)

### F-01: Identity private key stored as hex TEXT in items table

**Severity:** Critical
**Location:** `src/services/crypto/keyGenerationService.ts:100-101`, `src/services/crypto/cryptoService.ts:123-133`

The identity private key is stored as hex TEXT in SQLCipher `items` table. This is the most critical secret in the protocol. Must move to iOS Keychain (Secure Enclave) / Android Keystore (TEE/Strongbox). Tracked as Issue #54.

### F-02: hexToUint8Array silently converts invalid hex to zero bytes

**Severity:** High
**Location:** `src/services/crypto/utils.ts:13-23`

`parseInt('zz', 16)` returns NaN, which silently becomes 0 in Uint8Array. A corrupted hex key would produce an all-zeros key without error. Fix: add `Number.isNaN(byte)` check.

### F-03: keyGenerationService uses BEGIN TRANSACTION instead of BEGIN IMMEDIATE

**Severity:** High
**Location:** `src/services/crypto/keyGenerationService.ts:98, 273, 386`

Three operations use `BEGIN TRANSACTION` (deferred) instead of `BEGIN IMMEDIATE`. This could allow concurrent read-then-write interleaving. `cryptoService.ts` correctly uses `BEGIN IMMEDIATE`.

### F-04: PoC roundtrip functions exported in production binary

**Severity:** High
**Location:** `packages/orbital-signal/rust/orbital_signal/src/roundtrip.rs`, `lib.rs:7`

`test_encrypt_decrypt_roundtrip` and `test_encrypt_decrypt_roundtrip_n` are callable from TypeScript in release builds. Must gate behind `#[cfg(debug_assertions)]`. Tracked as Issue #40.

---

## Should-Fix Before Beta (Medium)

- **F-05:** Deprecated IdentityKeyStoreImpl uses `BEGIN TRANSACTION` — fix or remove
- **F-06:** `bytesEqual` not constant-time — use XOR accumulation pattern
- **F-07:** Dead store adapter code exported — extract `to_protocol_address` only
- **F-08:** `console.warn` in authService not `__DEV__`-gated

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
- SQLCipher configuration (cipher_memory_security, WAL, raw-key)
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

**The Phase 1 crypto foundation is architecturally sound and suitable to build upon, contingent on resolving Critical/High findings before beta release.**
