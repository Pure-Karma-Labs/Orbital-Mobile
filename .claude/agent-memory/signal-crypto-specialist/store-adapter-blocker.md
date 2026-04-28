---
name: Store Adapter Blocker — FULLY RESOLVED
description: uniffi 0.31 FfiConverterArc blocker is fully resolved — all 10 protocol functions implemented with preloaded store pattern, security audit passed
type: project
---

**Status: FULLY RESOLVED AND IMPLEMENTED (2026-04-09)**

The FfiConverterArc limitation in uniffi 0.31 was the single largest blocker for the crypto pipeline. It is now fully resolved:

- All 10 protocol functions implemented with preloaded Input/Result records
- TypeScript orchestration layer complete at `src/services/crypto/cryptoService.ts`
- Security audit validated the architecture

**Resolution:** Preloaded store architecture. See `preloaded-store-architecture.md` for full details.

**Remaining cleanup:** Dead code modules (`client.rs`, `stores.rs`) should be removed. `store_adapters.rs` has a `to_protocol_address()` helper still used by session.rs and group.rs — extract it before deleting.

**Why:** This memory exists to record that the blocker is resolved and what approach was taken, so future conversations don't revisit rejected alternatives.

**How to apply:** No action needed unless upgrading uniffi versions. The preloaded pattern is the established architecture.
