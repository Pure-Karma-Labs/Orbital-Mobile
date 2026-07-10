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

- `ITSAppUsesNonExemptEncryption` = `true` (set in Info.plist). The app bundles its own libsignal-based crypto, which is non-exempt; `false` is only for apps using no encryption or exempt-only forms (OS-provided HTTPS, authentication-only). History: the flag was incorrectly `false` from 2026-06-25 (`640057d`) to 2026-07-10 while "awaiting an ERN" — a number BIS eliminated in 2016 and never sends. Do not flip it back.
- App Store Connect presents the export compliance questionnaire on the first upload after the flag change. The ASC questions and Orbital's answers (Apple track — distinct from the BIS track below):
  1. Does your app use encryption? → **Yes** (libsignal + SQLCipher, not Apple OS crypto)
  2. Qualifies for any Category 5 Part 2 exemption? → **No** (full-strength E2EE content encryption; exemptions cover authentication-only/limited cases. Same posture as Signal/WhatsApp. License Exception ENC is an EAR mechanism, NOT a Cat 5 Pt 2 exemption)
  3. Implements proprietary/non-standard algorithms? → **No** (AES-256-GCM, X25519 RFC 7748, HKDF RFC 5869 — IETF/NIST standards; ML-KEM-1024/Kyber1024 is NIST FIPS 203, Aug 2024 — a published standard, not proprietary)
  4. Implements standard algorithms instead of / in addition to Apple's OS crypto? → **Yes** (libsignal/Rust, not CommonCrypto/CryptoKit)
  5. Available in France? → **No** (US-only)
- **Expected outcome under this configuration (standard algorithms + US-only): the questionnaire terminates with NO documentation upload and Apple issues NO `ITSEncryptionExportComplianceCode`.** Contingency only: if Apple unexpectedly requests documentation, upload the filed 2026-06-26 BIS self-classification CSV/email plus this document as rationale (no CCATS exists or is needed). If a code is ever issued, add it to Info.plist to skip future prompts.
- **BIS track (separate U.S. regulatory obligation, NOT an ASC question):** the annual self-classification report was filed 2026-06-26 and re-files each year per the BIS section above. **BIS sends no acknowledgment, license number, or registration number** (ERNs were eliminated in 2016; a CCATS is an optional classification request we have not sought and do not need). The sent filing email is the compliance record.
- App Review note for the correcting submission (1.7.1): "Export compliance declaration corrected: ITSAppUsesNonExemptEncryption changed from false to true. BIS self-classification report (ECCN 5D002, License Exception ENC) was filed 2026-06-26."
- France/ANSSI declaration: not applicable — US-only distribution on both stores; revisit only if availability expands to France
