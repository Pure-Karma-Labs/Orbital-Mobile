---
name: Store Adapter Blocker - uniffi FfiConverterArc
description: Critical blocker preventing store-backed protocol functions from being wired up - uniffi 0.31 cannot pass Arc<dyn CallbackInterface> to Object constructors
type: project
---

**Blocker:** uniffi 0.31.0 cannot pass `Arc<dyn CallbackInterface>` through exported functions or Object constructor parameters. The `FfiConverterArc` trait bound is not satisfied for callback interface types.

**What's written but dead-code:** `store_adapters.rs` (6 adapter structs bridging our callback interfaces to libsignal async traits) and `client.rs` (OrbitalSignalClient that would hold the adapters). Both compile but are `#[allow(dead_code)]` in lib.rs because they can't be exposed through uniffi.

**Store adapter pattern (working Rust, blocked at FFI boundary):**
1. TypeScript implements our callback interfaces (e.g., OrbitalIdentityKeyStore) backed by SQLCipher
2. Rust receives Arc<dyn OrbitalIdentityKeyStore> and wraps it in IdentityKeyStoreAdapter
3. IdentityKeyStoreAdapter implements libsignal's IdentityKeyStore via #[async_trait(?Send)]
4. Protocol functions (process_pre_key_bundle, signal_encrypt, etc.) use the adapter

**Two resolution paths identified:**
1. **uniffi upgrade:** Wait for/find a uniffi version that supports Arc<dyn CallbackInterface> in Object constructors. Check uniffi 0.32+ changelogs.
2. **Native-side client pattern:** Build OrbitalSignalClient in Swift/Kotlin that holds store references natively, calls libsignal directly, and exposes simpler result types to TypeScript through uniffi. This avoids the callback interface Arc problem entirely but requires platform-specific code.

**Why:** This is the single blocker for the entire crypto pipeline. The 10 stubbed functions (session, group, sealed sender) cannot be implemented until stores can be passed to Rust.

**How to apply:** When resuming crypto work, evaluate both paths. The native-side client (path 2) is likely more robust long-term since it avoids the async_trait(?Send) / uniffi async mismatch too. Coordinate with rust-native-engineer on this decision.
