---
name: libsignal API quirks discovered during wrapper implementation
description: Non-obvious API behaviors in libsignal-protocol v0.83.0 that caused build failures or incorrect code
type: project
---

Several libsignal API details are not well-documented and caused issues during Issue #8 implementation.

**DeviceId is NonZeroU8 (1-127), not u32:**
Device IDs in the ProtocolAddress constructor require NonZeroU8, meaning valid range is 1-127. Our FFI types use u32 for simplicity. The store_adapters.rs to_protocol_address helper clamps: `data.device_id.min(127).max(1) as u8`.

**GenericSignedPreKey trait must be imported:**
SignedPreKeyRecord and KyberPreKeyRecord methods like `.id()`, `.public_key()`, `.signature()`, `.timestamp()` are NOT inherent methods — they come from the `GenericSignedPreKey` trait. Forgetting `use libsignal_protocol::GenericSignedPreKey` causes "method not found" errors.

**PreKeyBundle::new requires Kyber params (10 args):**
The constructor requires Option Kyber pre-key ID, public key, and signature even for non-PQ bundles. Must pass None/None/None for the 3 Kyber params when not using post-quantum keys.

**Store traits use #[async_trait(?Send)]:**
libsignal's IdentityKeyStore, SessionStore, etc. produce non-Send futures via `#[async_trait(?Send)]`. uniffi async exports require Send futures. These are fundamentally incompatible — cannot just wrap one in the other.

**IdentityChange vs bool for save_identity:**
libsignal's IdentityKeyStore::save_identity returns `IdentityChange` (not bool). Use `IdentityChange::from_changed(bool)` to convert from the callback interface's bool return.

**How to apply:** Reference this when modifying the Rust crate, especially when implementing the stubbed functions or upgrading libsignal versions.
