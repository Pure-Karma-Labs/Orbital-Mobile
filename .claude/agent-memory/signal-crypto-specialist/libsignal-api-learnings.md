---
name: libsignal v0.83.0 API Learnings
description: Actual libsignal API behaviors discovered during implementation that differ from spec assumptions or are non-obvious
type: project
---

Key findings from implementing the Rust wrapper crate (issue #8, closed 2026-04-07):

**PreKeyBundle::new takes 10 args (Kyber required):** The constructor requires Kyber pre-key fields (id, public_key, signature) as Option params. Cannot construct a bundle without at least the Kyber slots present, even if None.

**DeviceId is NonZeroU8:** libsignal_core::DeviceId wraps a NonZeroU8, not u32. Our adapter clamps u32 device_id to 1-127 range. This means max 127 devices per user (more than enough for mobile-only beta). The clamping is in store_adapters.rs `to_protocol_address()`.

**Store traits use async_trait(?Send):** libsignal's store traits (IdentityKeyStore, SessionStore, etc.) are `#[async_trait(?Send)]`, producing non-Send futures. This is important because uniffi async by default expects Send futures. This mismatch is part of the store adapter blocker.

**Key sizes confirmed by tests:**
- Identity public key: 33 bytes (0x05 Curve25519 prefix + 32 bytes)
- Identity private key: 32 bytes
- Signed pre-key signature: 64 bytes (Ed25519)
- Kyber1024 record: ~3200 bytes serialized
- Kyber1024 public key: ~1568 bytes

**GenericSignedPreKey trait:** Required for calling serialize/deserialize/id/signature/public_key on both SignedPreKeyRecord and KyberPreKeyRecord. Must be imported explicitly.

**Error mapping is exhaustive:** The From<SignalProtocolError> impl covers all known variants including: CurveError bridge (via From<CurveError> -> From<SignalProtocolError>), ApplicationCallbackError for store failures, InvalidRegistrationId, InvalidProtocolAddress, plus a catch-all for future variants.

**Timestamp is not u64 directly:** libsignal uses `Timestamp::from_epoch_millis(u64)` and `.epoch_millis()` for conversion.

**IdentityChange enum:** save_identity returns `IdentityChange` not `bool`. Use `IdentityChange::from_changed(bool)` to bridge from our callback interface's bool return.

**Why:** These learnings prevent rediscovering the same API quirks when implementing the stubbed functions.

**How to apply:** Reference when unblocking store adapters or implementing the 10 stubbed protocol functions.
