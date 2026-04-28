---
name: Phase 1 Crypto Foundation — Complete and Audited
description: Phase 1 crypto pipeline fully implemented and security-audited; all Critical/High findings resolved; Phase 2 issues #76-#82 created
type: project
---

**Status: PHASE 1 COMPLETE (2026-04-09)**

All Phase 1 crypto foundation work is implemented, audited, and merged:

- 10 protocol functions (4 session + 4 group + 2 key exchange) with preloaded store pattern
- 4 key generation functions
- 5 utility functions
- TypeScript orchestration layer (cryptoService.ts) with per-address locking and BEGIN IMMEDIATE transactions
- 6 SignalProtocolStore implementations backed by SQLCipher
- Identity key migrated to Keychain/Keystore (Issue #54 resolved)
- PoC roundtrip feature-gated behind `#[cfg(feature = "dev-roundtrip")]` (Issue #40 resolved)
- Security audit passed — all Critical/High findings resolved

**Phase 2 issues created (#76-#82):** Thread UI, group management, WebSocket, offline-first. These will drive the content encryption service (AES-GCM with group keys) and media encryption service (AES-256-CBC + HMAC-SHA256) which are the next crypto deliverables.

**Remaining crypto work for Phase 2+:**
1. Content encryption service — AES-GCM with per-field IVs using group keys for thread/reply fields
2. Media encryption service — AES-256-CBC with HMAC-SHA256, 64-byte attachment keys
3. Sealed sender — blocked on backend SenderCertificate infrastructure
4. Dead code cleanup — client.rs, stores.rs removal; to_protocol_address extraction from store_adapters.rs

**Why:** Marks the Phase 1 boundary and records what carries forward into Phase 2.

**How to apply:** When Phase 2 issues reference crypto work, the foundation is in place. Focus on the encryption service layers that sit on top of the protocol functions, not the protocol functions themselves.
