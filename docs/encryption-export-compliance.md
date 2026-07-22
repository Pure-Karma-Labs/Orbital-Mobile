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
| AES-256-GCM | Content encryption (threads, replies, group names) | `aes-gcm` 0.11 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/content_crypto.rs`, `src/services/crypto/contentCrypto.ts` |
| AES-256-CBC + HMAC-SHA256 | Attachment encryption (media, avatars) | `aes` 0.8, `hmac` 0.12 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs`, `src/services/crypto/attachmentCrypto.ts` |
| X25519 ECDH | ECIES key agreement for group key wrapping | `x25519-dalek` 3.0 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| XEdDSA (Ed25519) | Sender authentication in ECIES envelopes | `curve25519-dalek` (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| HKDF-SHA256 | Key derivation with domain separation | `hkdf` 0.12 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` |
| SHA-256 | Content digests, integrity verification | `sha2` 0.10 (Rust) | `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs` |
| Signal Protocol | Double Ratchet, X3DH, Sealed Sender | `libsignal-protocol` v0.97.4 (Rust, via uniffi) | `packages/orbital-signal/` |
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

- `ITSAppUsesNonExemptEncryption` = **`false`** (set in Info.plist). **Owner decision 2026-07-10** after completing the ASC App Encryption Documentation walkthrough with honest disclosure (standard encryption algorithms selected, France = No): ASC's own conclusion screen states *"Based on your answers, you don't need to upload any documents. You can specify that you don't use encryption in the information property list (Info.plist)…"* — screenshot saved with the compliance records. This follows the literal definition of the key (set `NO` when the app "only uses forms of encryption that are **exempt from export compliance documentation requirements**"): per Apple's reference table, the standard-algorithms tier's only documentation requirement is the French declaration, and US-only distribution has none.
  - Two readings exist. The conservative one (used by Signal/WhatsApp, who distribute in France and therefore sit in the documentation tier regardless) sets `true` for any bundled non-OS crypto and answers the questionnaire per submission. Orbital adopts the literal reading, on Apple's own UI instruction for our disclosed answers. The encryption WAS fully disclosed in the ASC walkthrough (answers on file: uses encryption yes / proprietary no / standard-instead-of-OS yes / France no) — the flag is not a claim that the app lacks encryption; it is Apple's opt-out of per-build questioning for apps with no documentation requirement.
  - **⚠️ FRANCE TRIPWIRE (hard precondition):** if distribution EVER expands to France, this flag MUST flip to `true` and an ANSSI French encryption declaration MUST be filed BEFORE the expansion. The flag value is coupled to the distribution footprint under the literal reading. Also re-check this decision if Apple's key definition or the documentation table changes.
  - Do NOT upload export-compliance documents to ASC voluntarily — none are required, uploads can route the app into trade-compliance document review, and a reviewed document mints an `ITSEncryptionExportComplianceCode` that every subsequent binary must then carry (this matching error blocked a build upload on 2026-07-10).
  - No `ITSEncryptionExportComplianceCode` exists or is expected — that code is only issued after Apple reviews uploaded documentation, which our tier never triggers.
- **BIS track (separate U.S. regulatory obligation, unaffected by the Apple flag):** the annual self-classification report was filed 2026-06-26 (ECCN 5D002, License Exception ENC §740.17(b)(1)) and re-files each year per the BIS section above. **BIS sends no acknowledgment, license number, or registration number** (ERNs were eliminated in 2016; a CCATS is an optional classification request we have not sought and do not need). The sent filing email is the compliance record. The EAR obligation is satisfied by the filing regardless of how Apple's plist key is set.
