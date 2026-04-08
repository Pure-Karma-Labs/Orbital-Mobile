---
name: API Surface v1 Design Decisions
description: Key decisions made while defining the 18-function libsignal API surface for Orbital-Mobile, now implemented in Rust
type: project
---

Completed `docs/libsignal-api-surface.md` v1.0 on 2026-04-07. Implemented in Rust crate at `packages/orbital-signal/rust/orbital_signal/` via issues #7, #8, #9 (all closed).

**18 functions across 4 domains + utilities:**
- Key generation (4): generate_identity_key_pair (sync), generate_pre_key (sync), generate_signed_pre_key (sync), generate_kyber_pre_key (async)
- Session management (4): process_pre_key_bundle, signal_encrypt, signal_decrypt, signal_decrypt_pre_key (all async, stubbed)
- Group messaging (4): create_sender_key_distribution_message, process_sender_key_distribution_message, group_encrypt, group_decrypt (all async, stubbed)
- Sealed sender (2): sealed_sender_encrypt, sealed_sender_decrypt (async, stubbed)
- Utility (4): get_pre_key_public, get_signed_pre_key_public, get_kyber_pre_key_public, create_protocol_address (all sync, implemented)

**8 functions fully implemented** with real libsignal calls (key gen + utilities). **10 functions stubbed** returning InternalError pending store adapter integration.

**Callback interfaces for stores:** All 6 stores use UniFFI callback interfaces -- TypeScript implements the store, Rust calls back during protocol operations. This keeps SQLCipher access in the TypeScript layer where op-sqlite already provides the driver.

**Flat error enum:** Single `SignalError` with 10 variants. Maps libsignal's `SignalProtocolError` exhaustively including CurveError bridge. Each variant carries a `reason: String` where useful.

**Why:** This spec is Layer 0 -- it unblocked issues #7 (uniffi toolchain), #8 (Rust crate), #9 (cross-compilation), and the entire crypto pipeline.

**How to apply:** The Rust crate is the source of truth for the implemented API. The UDL types use proc macros (uniffi::Record, uniffi::Enum, uniffi::Error, uniffi::export) not a separate UDL file.
