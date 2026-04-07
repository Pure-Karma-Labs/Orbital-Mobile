---
name: API Surface v1 Design Decisions
description: Key decisions made while defining the 18-function libsignal API surface for Orbital-Mobile
type: project
---

Completed `docs/libsignal-api-surface.md` v1.0 on 2026-04-07. Key decisions:

**18 functions, not 15:** Added 4 utility helpers (get_pre_key_public, get_signed_pre_key_public, get_kyber_pre_key_public, create_protocol_address) beyond the 14 core protocol functions. These extract public key components from serialized records for server upload without exposing private key material to TypeScript.

**Callback interfaces for stores:** All 6 stores use UniFFI callback interfaces -- TypeScript implements the store, Rust calls back during protocol operations. This keeps SQLCipher access in the TypeScript layer where op-sqlite already provides the driver.

**Async by default for store-touching functions:** Only 4 key generation functions are sync (3 Curve25519-based, 1 Kyber async due to ~5-10ms compute time). All 14 protocol functions are async because they involve store I/O.

**Flat error enum:** Single `SignalError` with 10 variants. Maps libsignal's `SignalProtocolError` to a simpler set. Each variant carries a `reason: String` where useful. UniFFI generates TypeScript subclasses automatically.

**Why:** This spec is Layer 0 -- it unblocks issues #5 (Rust crate), #6 (uniffi toolchain), and the entire #7-#11 crypto pipeline.

**How to apply:** Reference this spec for all downstream crypto implementation. The UDL in Appendix A is the source of truth for the Rust wrapper crate.
