---
name: libsignal API quirks discovered during wrapper implementation
description: Non-obvious API behaviors in libsignal-protocol v0.83.0 that caused build failures or incorrect code
type: project
---

Several libsignal API details are not well-documented and caused issues during implementation.

**DeviceId is NonZeroU8 (1-127), not u32:**
Device IDs in the ProtocolAddress constructor require NonZeroU8, meaning valid range is 1-127. Our FFI types use u32 for simplicity. libsignal-core provides `TryFrom<u32> for DeviceId` which returns `InvalidDeviceId` for out-of-range values. The store_adapters.rs `to_protocol_address` helper returns `SignalResult<ProtocolAddress>` and uses `DeviceId::try_from(data.device_id)`, returning `SignalProtocolError::InvalidArgument` for out-of-range values. The inverse helper is `to_address_data` which converts a `&ProtocolAddress` to `ProtocolAddressData`. (Note: older duplicate helpers `addr_to_data`/`data_to_addr` were removed in PR #35.)

**generate_kyber_pre_key returns KyberPreKeyResult, not Vec<u8>:**
As of PR #35, `generate_kyber_pre_key` returns a `KyberPreKeyResult` struct (defined in types.rs) with fields `record: Vec<u8>` and `is_last_resort: bool`, rather than a bare `Vec<u8>`. This allows the caller to know whether the key was generated as a last-resort key.

**GenericSignedPreKey trait must be imported:**
SignedPreKeyRecord and KyberPreKeyRecord methods like `.id()`, `.public_key()`, `.signature()`, `.timestamp()` are NOT inherent methods — they come from the `GenericSignedPreKey` trait. Forgetting `use libsignal_protocol::GenericSignedPreKey` causes "method not found" errors.

**PreKeyBundle::new requires Kyber params (10 args):**
The constructor requires Option Kyber pre-key ID, public key, and signature even for non-PQ bundles. Must pass None/None/None for the 3 Kyber params when not using post-quantum keys.

**Store traits use #[async_trait(?Send)]:**
libsignal's IdentityKeyStore, SessionStore, etc. produce non-Send futures via `#[async_trait(?Send)]`. uniffi async exports require Send futures. These are fundamentally incompatible — cannot just wrap one in the other.

**IdentityChange vs bool for save_identity:**
libsignal's IdentityKeyStore::save_identity returns `IdentityChange` (not bool). Use `IdentityChange::from_changed(bool)` to convert from the callback interface's bool return.

**PreKeyBundle requires Kyber in Orbital (PQXDH enforced):**
Our `process_pre_key_bundle` implementation enforces all 3 Kyber fields present — rejects bundles without post-quantum keys. This is stricter than Signal's default (which allows non-PQ fallback).

**SenderKeyMessage.distribution_id() returns Uuid directly:**
No Result wrapper — call `.distribution_id()` directly on `SenderKeyMessage`. Used in `group_decrypt` to determine which sender key to preload.

**SenderKeyDistributionMessage.distribution_id() returns Result<Uuid>:**
Unlike `SenderKeyMessage`, the distribution message version wraps in `Result` — must `.map_err()` it.

**InMemSenderKeyStore is separate from InMemSignalProtocolStore:**
Create with `InMemSenderKeyStore::new()`. The `InMemSignalProtocolStore` does NOT include a sender key store — group operations need a separate instance.

**message_decrypt vs message_decrypt_prekey — different function names:**
`libsignal_protocol::message_decrypt()` for SignalMessage (2 store params: session + identity). `libsignal_protocol::message_decrypt_prekey()` for PreKeySignalMessage (5 store params: session + identity + pre-key + signed-pre-key + kyber-pre-key).

**How to apply:** Reference this when modifying the Rust crate or upgrading libsignal versions.
