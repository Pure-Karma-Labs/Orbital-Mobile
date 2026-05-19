---
name: Legacy Data Tolerance
description: Backend returns plaintext orbit names and placeholder group keys from Desktop-era orbits; catch paths in conversationService.ts are defensive against mixed-population data, not dead code
type: project
---

The deployed orbital-backend has a mixed-population data problem: orbits created from Orbital-Desktop (or before encryption was added) have different field formats than orbits created from Orbital-Mobile.

## Legacy plaintext orbit names

Backend can return plaintext strings in `encryptedName` fields for Desktop-era orbits. `decryptGroupName()` (contentCrypto.ts) fails on these because they are not valid base64 -- the `base64ToArrayBuffer()` call throws. The catch in `mapGroupResponse()` (conversationService.ts:28-29) falls back to `'(unable to decrypt)'`.

## Legacy placeholder group keys

Backend can return `"placeholder-key"` as `encryptedGroupKey` for legacy orbits. `persistGroupKey()` calls `validateAndDecode()` which calls `base64ToArrayBuffer("placeholder-key")` and throws. The catch in `loadConversations()` (conversationService.ts:54-55) silently skips these groups.

## Stale docstring on persistGroupKey

The JSDoc on `persistGroupKey()` (contentCrypto.ts:81-82) claims: "If the key is not valid base64 or not 32 bytes (e.g. legacy placeholder), generates a fresh 32-byte key instead." This is **incorrect** -- the implementation just throws from `validateAndDecode()` on line 85. The caller's catch handles the failure. Do not trust this docstring when reasoning about error flow.

## Test account resolution (2026-05-01)

Legacy orbits on the deployed backend were cleaned up by direct PostgreSQL DELETE and new orbits created through the mobile encryption pipeline (proper AES-256-GCM keys + encrypted names). This resolves the immediate test environment but the defensive catch paths must remain -- any legacy user or future Desktop-to-Mobile migration will encounter the same mixed data.

## Legacy attachment_key type mismatch (added 2026-05-18)

Pre-commit-c30110f data stored `attachment_key` as base64 TEXT in the BLOB column. SQLite dynamic typing accepts TEXT into BLOB columns silently, but downstream Rust FFI (`attachmentDecrypt`) expects `Uint8Array`. The `normalizeAttachmentKey()` helper in `threadService.ts` handles three input types:
- `Uint8Array` — pass through
- `ArrayBuffer` — wrap in `new Uint8Array()`
- `string` — base64-decode via `base64ToArrayBuffer()` then wrap

After normalization, a 64-byte length check validates the key (32 AES + 32 HMAC).

This is the same pattern as legacy orbit names: the data format in the DB doesn't match what the code expects, and a normalization layer bridges the gap. See also [[phase1-completion]] for the broader BLOB-for-keys pattern decision.

**Why:** Desktop is being sunsetted but not all orbits have been migrated. The backend has no migration to re-encrypt legacy plaintext names or replace placeholder keys. New users joining old orbits will hit these code paths. Similarly, existing media rows may have TEXT-typed attachment keys that need normalization.

**How to apply:** Do NOT remove the try/catch fallbacks in conversationService.ts thinking they are dead code. Do NOT remove normalizeAttachmentKey() assuming all keys are Uint8Array — legacy rows persist. If future cleanup proposals target these paths, flag them as load-bearing for legacy data tolerance. A proper fix would be a backend migration that encrypts legacy names and replaces placeholder keys, or a mobile-side migration that detects and handles the format difference explicitly.
