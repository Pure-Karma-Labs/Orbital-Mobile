# Encryption Export Compliance

Reference document for U.S. Bureau of Industry and Security (BIS) self-classification and Apple App Store export compliance.

## ECCN Classification

**ECCN:** 5D002 — Software using or performing cryptographic functions

**License Exception:** ENC, 15 C.F.R. §740.17(b)(1) (authorization type code: `ENC`)

> Note: §740.17(b)(1) is License Exception ENC, not the "mass market" provision — mass market is §742.15(b) and would classify as 5D992 with authorization type `MMKT`. Orbital files as 5D002 + ENC, the standard posture for consumer E2EE messaging apps (Signal and WhatsApp use the same path).

Eligibility basis:
- App is publicly available via App Store / Play Store (consumer distribution)
- Encryption is used solely for data protection of user content
- No custom cryptographic hardware
- Consumer-facing social networking application
- No government/military end-use

## Encryption Inventory

| Algorithm | Purpose | Library | Codebase location |
|---|---|---|---|
| AES-256-GCM | Content encryption (threads, replies, group names) | `aes-gcm` 0.10 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/content_crypto.rs`, `src/services/crypto/contentCrypto.ts` |
| AES-256-CBC + HMAC-SHA256 | Attachment encryption (media, avatars) | `aes` 0.8, `hmac` 0.12 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs`, `src/services/crypto/attachmentCrypto.ts` |
| X25519 ECDH | ECIES key agreement for group key wrapping | `x25519-dalek` 2.0 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| XEdDSA (Ed25519) | Sender authentication in ECIES envelopes | `curve25519-dalek` (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| HKDF-SHA256 | Key derivation with domain separation | `hkdf` 0.12 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| SHA-256 | Content digests, integrity verification | `sha2` 0.10 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs` |
| Signal Protocol | Double Ratchet, X3DH, Sealed Sender | `libsignal-protocol` v0.95.0 (Rust, via uniffi) | `packages/orbital-signal/` |
| Kyber1024 / ML-KEM-1024 (FIPS 203) | Post-quantum pre-keys + PQ ratchet (256-bit shared secret) | `libcrux-ml-kem` (Cryspen/INRIA HACL*, **non-U.S. origin**) via libsignal → `spqr` | `packages/orbital-signal/rust/orbital_signal/src/keys.rs` (`generateKyberPreKey`) |
| SQLCipher (AES-256-CBC) | Local database encryption at rest | `op-sqlite` with SQLCipher flag | `src/database/connection.ts` |
| HTTPS/TLS | Transport encryption | OS-provided (exempt) | N/A |

## Key Management

- **Identity keys:** X25519 keypair generated at signup, private key stored in iOS Keychain / Android Keystore
- **Group keys:** 32-byte AES-256-GCM keys, ECIES-wrapped per member, stored server-side as ciphertext
- **Attachment keys:** 64-byte per-file keys (32 AES + 32 HMAC), never sent to server in plaintext
- **Database key:** 32-byte key generated on first launch, stored in Keychain/Keystore (raw CSPRNG output, not password-derived)
- **CSPRNG:** all key material generated via `crypto.getRandomValues()` (Hermes, RN 0.82+) in TypeScript and the `rand` crate in Rust

## BIS Self-Classification Filing

**Requirement:** Annual self-classification report per Supplement No. 8 to Part 742 of the EAR

**Filing details:**
- Due: February 1 each year (next deadline: February 1, 2027, covering CY 2026)
- Recipients: BIS (`crypt-supp8@bis.doc.gov`) and ENC Encryption Request Coordinator (`enc@nsa.gov`)
- Format: CSV only, exact 12-column Supp. 8 header. Note: the report does **not** include algorithm or key-length fields — those are internal rationale (this document), not filing fields.
- Filing package: `docs/compliance/bis-self-classification-2026.csv` + email templates in `docs/compliance/bis-filing-2026.md`. This document is canonical; each year's CSV is a snapshot derived from it.

**Report columns and Orbital's values:**

| Column | Value |
|---|---|
| PRODUCT NAME | Orbital |
| MODEL NUMBER | 1.0 (store-facing version: iOS `MARKETING_VERSION` / Android `versionName`) |
| MANUFACTURER | Pure Karma Labs |
| ECCN | 5D002 |
| AUTHORIZATION TYPE | ENC |
| ITEM TYPE | mobility and mobile applications n.e.s. |
| SUBMITTER NAME / TELEPHONE / E-MAIL / MAILING ADDRESS | filled at send time — kept out of git |
| NON-U.S. COMPONENTS | YES (`libcrux-ml-kem` — Cryspen/INRIA, via libsignal → `spqr`) |
| NON-U.S. MANUFACTURING LOCATIONS | NONE (U.S.-developed; column refers to product manufacturing, not component origin) |

## Apple App Store

- `ITSAppUsesNonExemptEncryption` = `true` (set in Info.plist)
- App Store Connect will present export compliance questions during submission
- Select: "Yes, the app uses encryption" and "The app qualifies for an exemption"
- If Apple issues an `ITSEncryptionExportComplianceCode`, add it to Info.plist to skip the prompt on future uploads
