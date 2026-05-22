---
name: Debt Registry
description: Persistent registry of all tracked tech debt items with severity, status, and linked issues
type: project
---

# Tech Debt Registry

Last updated: 2026-05-22

## Open Items

| ID | Severity | Title | Component | Remediation Cost | Status | Issue |
|----|----------|-------|-----------|-----------------|--------|-------|
| DEBT-003 | High | Store class tests missing (0/6 Signal stores tested) | Crypto / Testing | Large | Open | #53 |
| DEBT-005 | Medium | Logout domain reset fragile (manual slice enum) | State Management | Medium | Open | — |
| DEBT-010 | Medium | Bundle payload assembly duplicated 3x in keyGenerationService | Crypto | Small | Open | — |
| DEBT-011 | Medium | No shared withTransaction helper (6+ identical BEGIN/COMMIT/ROLLBACK blocks) | Database / Crypto | Small | Open | — |
| DEBT-007 | Low | Signup error message wrong for ValidationError | API / UI | Small | Open | — |
| DEBT-008 | Low | Persistence test verifies copy of partialize, not actual fn | Testing | Small | Open | — |
| DEBT-009 | Low | Hardcoded API base URL (no env-based config) | API | Small | Open | — |
| DEBT-015 | Low | ECIES wrapped-key scaffold: dead code awaiting receive-path wiring | Crypto / API / WebSocket | Small | Open | #95 |

## Resolved Items

| ID | Title | Resolution | Resolved Date |
|----|-------|-----------|---------------|
| DEBT-001 | Identity private key stored in SQLCipher, not Keychain/Keystore | Identity key moved to Keychain/Keystore | PR #83, 2026-04-09 |
| DEBT-002 | PoC roundtrip functions ship in production binary | Roundtrip functions feature-gated out of production builds | PR #84, 2026-04-09 |
| DEBT-012 | signal_encrypt inlines helpers that other session fns extract | signal_encrypt now uses shared build_runtime/reconstruct_identity_key_pair/create_store helpers | PR #75, 2026-04-09 |
| DEBT-013 | build_runtime() duplicated in session.rs and group.rs | group.rs imports build_runtime from crate::session | PR #75, 2026-04-09 |
| DEBT-014 | 6 deprecated store impl files still in codebase | All 6 files deleted | PR #75, 2026-04-09 |
| DEBT-004 | toArrayBuffer duplicated 6x across crypto store files | All 6 stores now import from src/services/crypto/utils.ts | PR #55, 2026-04-09 |
| DEBT-006 | No code path for last-resort Kyber pre-key | keyGenerationService.ts generates last-resort Kyber pre-key | PR #55, 2026-04-09 |
| — | FK constraints on orbital_media caused INSERT failures (out-of-order API data) | Migration 003: SQLite 12-step table rebuild to drop FKs; disableForeignKeys flag in runner | PR #148, 2026-05-22 |
| — | Op-sqlite Jest mock missing (tests fail on native module import) | Manual mock at __mocks__/@op-engineering/op-sqlite.js + modulePathIgnorePatterns for worktrees | PR #57, 2026-04-09 |
| — | MMKV encryption not enabled | Fixed | PR #45 |
| — | Selector hooks missing useShallow | Fixed | PR #37 |
| — | FormData serialization bug | Fixed | PR #41 |
| — | 403 response not clearing tokens | Fixed | PR #41 |
| — | camelToSnake acronym handling | Fixed | PR #41 |

## Details

### DEBT-010: Bundle payload assembly duplicated 3x in keyGenerationService

In `src/services/crypto/keyGenerationService.ts`, the `UploadPreKeyBundleRequest` object construction is duplicated across three functions: `uploadInitialPreKeyBundle` (line ~209), `checkAndReplenishPreKeys` (line ~326), and `checkAndRotateSignedPreKey` (line ~413). Each constructs an identical shape with `registrationId`, `identityKey`, `preKeys`, `signedPreKey`, `lastResortKyberPreKey`, and `kyberPreKeys`. Should extract into a `buildUploadPayload()` helper.

### DEBT-015: ECIES wrapped-key scaffold (intentional dead code)

Shipped as part of #95 (zero-knowledge group keys). Send paths are wired (createOrbit, startDm) but the receive/re-wrap paths are scaffolded only. The following items have no production callers yet:
- `submitWrappedKey()` and `getPendingWraps()` in `src/services/api/groups.ts`
- `SubmitWrappedKeyRequest`, `PendingWrapsResponse` types in `src/services/websocket/types.ts`
- WS handler stubs for `wrap_key_request` / `wrapped_key_delivered` in `src/services/websocket/messageHandler.ts` (break; no-op)
- `evictPendingCache()` in `src/services/crypto/contentCrypto.ts` (exported, tested, but never called outside tests)

This is intentional scaffold, not accidental dead code. Do NOT remove; it will be wired when receive-path group key wrapping is implemented. Track to ensure it doesn't stay dormant indefinitely.

### DEBT-011: No shared withTransaction helper

`cryptoService.ts` defines a local `withTransaction()` helper (line ~106) used 8 times internally but not exported. Meanwhile `keyGenerationService.ts` manually inlines `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` in 3 places, `messageRepository.ts` does the same with `BEGIN TRANSACTION`, and `IdentityKeyStoreImpl.ts` also inlines it. Should extract to `src/database/queryHelpers.ts` and share across modules.
