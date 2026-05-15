---
name: project-attachment-crypto
description: Attachment crypto design — AES-256-CBC+HMAC-SHA256, FFI bindings, build workflow
metadata:
  type: project
---

## Attachment Crypto Pipeline

**Rust source:** `packages/orbital-signal/rust/orbital_signal/src/attachment_crypto.rs` (492 lines, 18 tests)

**Functions:**
- `attachment_encrypt(plaintext: Vec<u8>, keys: Vec<u8>) -> AttachmentCryptoResult`
- `attachment_decrypt(ciphertext: Vec<u8>, keys: Vec<u8>, expected_digest: Vec<u8>) -> Vec<u8>`

**Key format:** 64 bytes — first 32 = AES-256 key, last 32 = HMAC-SHA256 key

**Ciphertext layout:** IV (16) || encrypted_data (PKCS7 padded) || HMAC-SHA256 (32)

**FFI bindings regenerated** (2026-05-14) via `ubrn build ios --and-generate`:
- TypeScript stubs replaced with real FFI calls in `orbital_signal.ts`
- C++ JSI bindings updated in `cpp/generated/`
- xcframework rebuilt (gitignored, local artifact)

**Build commands:**
- `ubrn build ios --config ubrn.config.yaml --and-generate --sim-only` (fast, sim-only)
- `ubrn build ios --config ubrn.config.yaml --and-generate` (full, device + sim)
- Requires `cmake` (for boring-ssl): `brew install cmake`

**Known gaps:**
- Android bindings not yet rebuilt
- Key material not zeroized (#114)
- Integration tests reference non-existent functions (broken compilation)
- `contentEncrypt`/`contentDecrypt` bindings may be missing from generated output
