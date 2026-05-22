---
name: project-ecies-module
description: ECIES group-key-wrap module (ecies.rs) — x25519+AES-GCM+HKDF, XEdDSA signing, 190-byte wire format, 15 unit tests
metadata:
  type: project
---

## ECIES Module (ecies.rs)

**Rust source:** `packages/orbital-signal/rust/orbital_signal/src/ecies.rs`
**Added:** 2026-05-21

**Purpose:** Encrypt group keys for individual recipients using ECIES (Elliptic Curve Integrated Encryption Scheme). Used for group key wrapping in Orbital's group messaging.

### Exported Functions

- `ecies_seal(recipient_pub: Vec<u8>, sender_identity_key_pair: Vec<u8>, plaintext: Vec<u8>) -> Vec<u8>`
- `ecies_open(recipient_identity_key_pair: Vec<u8>, ciphertext: Vec<u8>) -> EciesOpenResult` (returns plaintext + verified sender public key)

### Wire Format (190 bytes total for 32-byte plaintext)

```
version(1) || ephemeralPub(32) || nonce(12) || ct+tag(48) || senderPub(33) || signature(64)
```

- **version:** `0x01` — checked on open, rejects unknown versions
- **ephemeralPub:** X25519 public key (raw 32 bytes)
- **nonce:** AES-GCM nonce (12 bytes)
- **ct+tag:** AES-256-GCM ciphertext + authentication tag (plaintext_len + 16)
- **senderPub:** Signal IdentityKey (compressed 33-byte EC point)
- **signature:** XEdDSA signature over `version || ephemeralPub || nonce || ct+tag`

### Crypto Primitives & Dependencies

- **Key agreement:** x25519-dalek (already transitive dep via libsignal — no new crate)
- **Symmetric encryption:** aes-gcm (already used by content_crypto.rs — reused, not chacha20poly1305)
- **Key derivation:** HKDF-SHA256 (already transitive dep via libsignal)
- **Signing:** XEdDSA via `libsignal_core::curve::PrivateKey::calculate_signature` (Signal's own implementation)
- **Constant-time comparison:** `subtle::ConstantTimeEq` for sender identity verification

**Why:** AES-GCM was chosen over ChaCha20-Poly1305 to avoid adding a new dependency. Both x25519-dalek and hkdf are already transitive deps through libsignal, so ECIES added zero new crate dependencies.

### Key Implementation Details

1. **Small-order rejection:** Uses `was_contributory()` on the X25519 SharedSecret to reject all low-order points (identity, torsion). This catches invalid/malicious ephemeral keys at the DH step.

2. **HKDF channel binding:** Info string = `"orbital-group-key-wrap-v1" || ephemeralPub || recipientPubRaw`. Binding the ephemeral and recipient keys into the HKDF info prevents key confusion attacks.

3. **XEdDSA signing:** Uses libsignal's `PrivateKey::calculate_signature` which performs Montgomery-to-Edwards conversion internally. Signature covers `version || ephemeralPub || nonce || ct+tag` (all ciphertext fields before the sender identity block).

4. **Sender keypair cross-validation:** On seal, the provided sender keypair is validated by checking that the public key derived from the private key matches the provided public key. Prevents mismatched keypair bugs.

5. **Constant-time sender comparison:** `subtle::ConstantTimeEq` used when verifying the sender's identity against an expected value, preventing timing side-channels.

6. **Zeroization:** All sensitive intermediates (shared secret, derived key material, ephemeral private key) wrapped in `Zeroizing<>`. Follows the pattern from [[zeroize-pattern]].

### Unit Tests (15 tests)

- Roundtrip: seal then open with correct keys
- Wrong recipient key: open fails
- Tampered ciphertext: authentication fails
- Server substitution attack: modified sender identity detected
- Small-order point rejection: low-order ephemeral keys rejected
- Version byte validation: unknown version rejected
- Mismatched sender keypair: cross-validation catches inconsistency

### uniffi Binding Regeneration

Run from `packages/orbital-signal/`:
```bash
ubrn build ios --config ubrn.config.yaml --and-generate
```

- Do NOT manually edit generated files in `src/` (TS) or `cpp/generated/`
- Generated TypeScript functions take `ArrayBuffer` params (not `Uint8Array`)
- The `--and-generate` flag handles both compilation and binding generation in one step

**How to apply:** When modifying ecies.rs or adding new FFI-exposed functions, always regenerate bindings with the above command. The 190-byte wire format is a protocol constant — changing it requires versioning (bump the version byte).
