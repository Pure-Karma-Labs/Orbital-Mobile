---
name: project-ecies-construction
description: "ECIES group key wrapping construction — X25519 + AES-256-GCM + HKDF-SHA256 + XEdDSA signature; 190-byte wire format; channel binding and small-order rejection"
metadata:
  type: project
---

## ECIES Construction for Group Key Wrapping (2026-05-22)

### Primitives
- **Key Agreement:** X25519 (ephemeral-static ECDH)
- **Authenticated Encryption:** AES-256-GCM (32-byte key from HKDF, 12-byte nonce, 16-byte tag)
- **Key Derivation:** HKDF-SHA256 with channel binding info
- **Authentication:** XEdDSA signature over the entire sealed envelope (prevents unauthenticated ECIES / server key substitution)
- **Point Validation:** `was_contributory()` rejects small-order X25519 points

### Wire Format (190 bytes total, version 0x01)
```
[0]       version byte (0x01)
[1..33]   ephemeral X25519 public key (32 bytes)
[33..45]  AES-GCM nonce (12 bytes)
[45..77]  ciphertext (32 bytes — the wrapped group key)
[77..93]  AES-GCM tag (16 bytes)
[93..157] XEdDSA signature (64 bytes)
```
Total: 1 + 32 + 12 + 32 + 16 + 64 = 157... (verify against code — user stated 190 bytes)

Note: The 190-byte figure was stated by the user. The breakdown above sums to 157 bytes. The discrepancy may be due to additional padding, a different field layout, or base64 overhead. Verify against the Rust source (`ecies.rs`) in future sessions.

### Channel Binding
- HKDF `info` parameter includes both `ephemeralPub || recipientPub` (32 + 32 = 64 bytes)
- Prevents cross-recipient attacks where the server relays an envelope to a different recipient

### Security Properties Achieved
1. **Confidentiality:** X25519 DH + HKDF + AES-256-GCM ensures only the intended recipient can decrypt
2. **Sender Authentication:** XEdDSA signature proves the sender's identity (prevents server key substitution — was a Critical finding, now fixed)
3. **Recipient Binding:** HKDF info includes both public keys (prevents envelope reuse across recipients — was a High finding, now fixed)
4. **Small-Order Rejection:** `was_contributory()` prevents invalid-curve / small-subgroup attacks on X25519

### Key Findings and Resolutions
- **Critical (fixed):** Unauthenticated ECIES allowed server to substitute group keys silently. Fix: XEdDSA signature added.
- **High (fixed):** HKDF had no context binding. Fix: ephemeralPub + recipientPub in info field.
- **Design choice (TOFU):** Identity keys are trust-on-first-use. Acceptable for family app, but safety number comparison UI needed long-term to detect MITM.

**Why:** Documents the exact cryptographic construction so future audits can verify it hasn't regressed and new agents understand the security properties.
**How to apply:** When reviewing any PR that touches `ecies.rs`, `ecies_seal`, `ecies_open`, or the wire format, verify these invariants are preserved. Any change to field layout, signature scope, or HKDF info is a Critical-severity change requiring full re-audit.
