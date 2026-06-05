# Encryption Export Compliance

Reference document for U.S. Bureau of Industry and Security (BIS) self-classification and Apple App Store export compliance.

## ECCN Classification

**ECCN:** 5D002 — Software using or performing cryptographic functions

**Exemption:** EAR 740.17(b)(1) — Mass market encryption software

Eligibility basis:
- App is publicly available via App Store / Play Store (mass market)
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
| Signal Protocol | Double Ratchet, X3DH, Sealed Sender | `libsignal-client` (Rust, via uniffi) | `packages/orbital-signal/` |
| SQLCipher (AES-256-CBC) | Local database encryption at rest | `op-sqlite` with SQLCipher flag | `src/database/connection.ts` |
| HTTPS/TLS | Transport encryption | OS-provided (exempt) | N/A |

## Key Management

- **Identity keys:** X25519 keypair generated at signup, private key stored in iOS Keychain / Android Keystore
- **Group keys:** 32-byte AES-256-GCM keys, ECIES-wrapped per member, stored server-side as ciphertext
- **Attachment keys:** 64-byte per-file keys (32 AES + 32 HMAC), never sent to server in plaintext
- **Database key:** 32-byte key generated on first launch, stored in Keychain/Keystore

## BIS Self-Classification Filing

**Requirement:** Annual self-classification report per Supplement No. 8 to Part 742 of the EAR

**Filing details:**
- Due: February 1 each year (next deadline: February 1, 2027)
- Recipients: BIS (`crypt@bis.doc.gov`) and ENC Encryption Request Coordinator (`enc@nsa.gov`)
- Format: CSV per Supplement No. 8 specifications

**Required fields:**
- Product name: Orbital
- Model/version: 1.0
- Manufacturer: Pure Karma Labs
- ECCN: 5D002
- Authorization type: 740.17(b)(1)
- Encryption algorithm(s): AES-256-GCM, AES-256-CBC, X25519, HKDF-SHA256, Signal Protocol
- Key lengths: 256-bit (AES), 256-bit (X25519)

## Apple App Store

- `ITSAppUsesNonExemptEncryption` = `true` (set in Info.plist)
- `ITSEncryptionExportComplianceCode` = empty string (no CCATS filed; mass-market exemption applies)
- App Store Connect will present export compliance questions during submission
- Select: "Yes, the app uses encryption" and "The app qualifies for an exemption"

## French ANSSI Declaration

Not required. The app uses only standard, publicly available cryptographic libraries (no custom algorithms). ANSSI declarations apply only to apps that implement proprietary encryption or use encryption in ways not covered by standard library usage.
