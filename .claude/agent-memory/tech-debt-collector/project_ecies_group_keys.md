---
name: ecies-group-keys-status
description: Zero-knowledge group key (#95) architecture — send paths wired, receive paths scaffolded, Rust ECIES primitive landed
metadata:
  type: project
---

Issue #95 introduced zero-knowledge group keys using ECIES (Elliptic Curve Integrated Encryption Scheme).

**Current state (2026-05-22):**
- Rust ECIES primitive landed in `ecies.rs` with 15 tests
- Backend: `wrapped_group_key` field rename, `submitWrappedKey`/`getPendingWraps` endpoints, `wrapped_by` column
- Mobile send paths wired: `createOrbit` and `startDm` encrypt and send wrapped group keys
- Mobile receive paths: scaffolded only (API functions, WS handlers, types defined but no consumers)
- `identityKeyAccess.ts` created as shared module for identity key pair retrieval (used by `contentCrypto.ts` and `conversationService.ts`)
- Coverage threshold (65% functions) met via `contentCrypto.ecies.test.ts`

**Why this matters for debt tracking:** The scaffold code (DEBT-015) is intentional and should not be removed. It should be wired when multi-device or key re-wrapping flows are implemented. Monitor to ensure it doesn't stay dormant beyond Phase 2.

**How to apply:** When reviewing PRs that touch crypto or group key flows, verify they use the existing scaffold rather than creating parallel implementations. The `identityKeyAccess.ts` module is the canonical way to get the identity key pair -- new code should not re-derive it from keyGenerationService directly.

Related: [[debt-registry]] (DEBT-015), [[fk-migration-lesson]]
