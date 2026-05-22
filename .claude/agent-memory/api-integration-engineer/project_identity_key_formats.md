---
name: identity-key-formats
description: Critical distinction between DJB identity keys (from getPreKeyBundle, base64 33-byte) and JWK public keys (from profile) — wrong format causes ECIES failures
metadata:
  type: project
---

## Identity Key Format Distinction

There are two different "public key" formats in the system. Using the wrong one causes silent ECIES encryption/decryption failures.

### DJB Identity Key (for ECIES / group key wrapping)
- **Source:** `getPreKeyBundle().identityKey`
- **Format:** Base64-encoded, 33 bytes (DJB Curve25519 with 0x05 prefix)
- **Used for:** ECIES encryption when wrapping group keys for a specific user
- **Backend field:** `identity_public_key` (stored via `POST /v1/keys/bundle`)

### JWK Public Key (for profile/auth)
- **Source:** User profile `publicKey` field
- **Format:** JWK (JSON Web Key) format
- **Used for:** NOT for ECIES wrapping — this is a different key type

### The wrappedBy field

The `wrappedBy` field on GroupResponse, GroupKeyResponse, CreateDmResponse, DmResponse is a **userId (UUID)**, not the actual public key. To get the ECIES identity key for unwrapping:

1. Read `wrappedBy` (userId) from the response
2. Call `getPreKeyBundle(wrappedBy)` to get the pre-key bundle
3. Use `bundle.identityKey` (base64 DJB 33 bytes) for ECIES operations

**Why:** Early implementation attempted to use profile `publicKey` (JWK) for ECIES, which silently fails. The DJB key from the pre-key bundle is the only correct key for Signal-compatible ECIES operations.

**How to apply:** Whenever implementing group key wrapping/unwrapping, always resolve identity keys via `getPreKeyBundle()`, never from user profile objects. See [[issue-95-wrapped-key-contract]] for the full API contract.
