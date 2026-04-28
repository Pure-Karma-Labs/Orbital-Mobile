---
name: uniffi callback interface blocker — RESOLVED via Preloaded Store Pattern
description: uniffi 0.31 cannot pass Arc<dyn CallbackInterface> to any exported function; solved by serialized Input/Result records + InMemSignalProtocolStore; store_adapters.rs is dead code
type: project
---

## The Blocker (confirmed, not a bug — fundamental uniffi limitation)

uniffi 0.31.0 does NOT support `Arc<dyn CallbackInterface>` as parameters to ANY exported function — sync or async. The `FfiConverterArc` trait bound is not implemented for callback interface traits.

**Exact error:**
```
error[E0277]: the trait bound `(dyn OrbitalIdentityKeyStore + 'static): FfiConverterArc<UniFfiTag>` is not satisfied
```

This blocks the original architecture where TypeScript store implementations would be passed into Rust protocol functions as callback interfaces.

## The Solution: Preloaded Store Pattern (proven by Issue #58 spike)

All 10 store-backed protocol functions use typed Input/Result records instead of callback interfaces:

1. **TypeScript** reads required store data from SQLCipher, serializes it into a `*Input` record (e.g., `EncryptInput`)
2. **Rust** receives the `*Input`, creates an `InMemSignalProtocolStore`, populates it from the serialized fields, runs the libsignal operation via `block_on()`, and returns a `*Result` record (e.g., `EncryptResult`) containing the output plus any store mutations
3. **TypeScript** applies mutations from `*Result` back to SQLCipher in a transaction

**Validation:** `signal_encrypt` with `EncryptInput`/`EncryptResult` compiles and works end-to-end. This was the Phase 1 spike (Issue #58).

## Dead Code: store_adapters.rs

`store_adapters.rs` (6 adapter structs bridging callback interfaces to libsignal async traits) and the `OrbitalSignalClient` in `client.rs` are dead code. They were designed for the callback approach that does not work. Both are `#[allow(dead_code)]` in lib.rs. These should be removed when the Preloaded Store Pattern is fully adopted.

## Implications for the Remaining 9 Functions

Each of the 10 store-backed functions needs its own `*Input` / `*Result` pair:

| Function | Input needs | Result mutations |
|---|---|---|
| signal_encrypt | session, identity keys, address | updated session |
| signal_decrypt (pre-key) | session, identity, pre-keys, signed pre-keys, kyber keys | new/updated session, consumed pre-key, identity save |
| signal_decrypt (standard) | session, identity | updated session |
| process_pre_key_bundle | identity keys, bundle data | new session, identity save |
| group_encrypt | sender key state | updated sender key |
| group_decrypt | sender key state | updated sender key |
| sealed_sender_encrypt | session, identity, sender cert | updated session |
| sealed_sender_decrypt | session, identity, pre-keys, signed pre-keys, sender key | new/updated session, consumed pre-key |
| create_sender_key_distribution | sender key state | new sender key |
| process_sender_key_distribution | sender key distribution msg | stored sender key |

**Key design principle:** Each Input must carry ALL store data the libsignal function could possibly read. Each Result must carry ALL mutations the function could possibly write. TypeScript is responsible for reading before and writing after -- Rust is a pure compute step.

**Why this is superior to the original callback approach:**
- No FFI boundary crossings during protocol operations (eliminates async bridge round-trips)
- No `async_trait(?Send)` incompatibility -- `block_on()` wraps libsignal's async in synchronous Rust
- Store transactions are managed entirely in TypeScript/SQLCipher where they belong
- Simpler to test -- Input/Result are plain data, no mock callback wiring

**How to apply:** When implementing each remaining function, follow the `signal_encrypt` pattern from Issue #58. Define the Input/Result types in `types.rs`, implement the function in `lib.rs` using `InMemSignalProtocolStore`, and expose via uniffi proc macros. The signal-crypto-specialist defines which store fields each Input needs; the rust-native-engineer implements the Rust side.
