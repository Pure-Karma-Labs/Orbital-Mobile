---
name: API Surface v1 — Implementation Complete
description: 21-function libsignal API surface — all 10 protocol functions implemented with preloaded store pattern; 4 key gen + 5 utility implemented; 2 sealed sender deferred; PoC feature-gated (Issue #40 resolved)
type: project
---

Spec at `docs/libsignal-api-surface.md` v1.0 (2026-04-07). Implemented in Rust crate at `packages/orbital-signal/rust/orbital_signal/`.

**21 functions across 4 domains + utilities + PoC:**

### Fully implemented (19):
- **Key generation (4):** generate_identity_key_pair (sync), generate_pre_key (sync), generate_signed_pre_key (sync), generate_kyber_pre_key (async) -- Issues #7-9, closed
- **Session management (4):** process_pre_key_bundle, signal_encrypt, signal_decrypt, signal_decrypt_pre_key -- all sync exports with tokio block_on, preloaded Input/Result records
- **Group messaging (4):** create_sender_key_distribution_message, process_sender_key_distribution_message, group_encrypt, group_decrypt -- all sync exports, preloaded pattern, uses InMemSenderKeyStore
- **Utility (5):** get_pre_key_public, get_signed_pre_key_public, get_kyber_pre_key_public, create_protocol_address, parse_prekey_message_ids
- **PoC roundtrip (2):** test_encrypt_decrypt_roundtrip, test_encrypt_decrypt_roundtrip_n -- feature-gated behind `#[cfg(feature = "dev-roundtrip")]` (Issue #40 resolved), not included in production builds

### Deferred (2):
- **Sealed sender:** sealed_sender_encrypt, sealed_sender_decrypt -- stubs return InternalError, blocked on backend SenderCertificate infrastructure

**Architecture:** All 10 protocol functions use the **preloaded store pattern** -- Input records carry serialized store data from TypeScript, Rust hydrates InMemSignalProtocolStore or InMemSenderKeyStore, runs libsignal, returns Result records with updated store data for TypeScript to persist.

**TypeScript orchestration layer** at `src/services/crypto/cryptoService.ts` wraps all 10 protocol functions with: per-address promise-queue locking, BEGIN IMMEDIATE transactions for store mutations, auto-session establishment (encrypt auto-calls establishSession via pre-key bundle fetch).

**Dead code still present (cleanup needed):**
- `store_adapters.rs` -- 6 adapter structs (still imported by session.rs and group.rs for `to_protocol_address` helper)
- `client.rs` -- OrbitalSignalClient
- `stores.rs` -- 6 callback interface trait definitions

**Flat error enum:** Single `SignalError` with 10 variants. Maps libsignal's `SignalProtocolError` exhaustively.

**Why:** This spec is Layer 0 -- it defined the entire crypto pipeline for Phase 1.

**How to apply:** The protocol function implementations are complete for 1:1 and group messaging. Phase 1 crypto foundation is audited and clean (all Critical/High security findings resolved). Next priorities: (1) sealed sender when backend certificates are ready, (2) content encryption service (AES-GCM with group keys for thread/reply fields), (3) media encryption service (AES-256-CBC + HMAC-SHA256).
