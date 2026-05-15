# Issue #92 Cleanup — Review Findings for Future Phases

**Date:** 2026-05-11
**PRs:** #97, #99 (merged)

## What was removed

19 dead API endpoint functions, the message UI subsystem (messagesSlice, messageRepository, useMessages hook), and the `rawResponse` option in `client.ts`. ~1,547 lines deleted.

## What was kept and why

- **~25 type interfaces in `types/api.ts`** — backend contract docs for Phase 2-4. No runtime cost but no compiler enforcement that they still match the backend. Verify against `Pure-Karma-Labs/Orbital-Backend` routes before using.
- **`MessageRow`/`MessageAttachmentRow` in `types/database.ts`** — describe live SQL schema (`messages` table has FK dependencies). No current importers.
- **`buildQueryString` in `client.ts`** — still used by `threads.ts`.

## Reconstruction notes

When rebuilding deleted functions, these non-obvious details aren't captured by the types alone:

1. **`media.ts` uploadChunk** — uses manual snake_case FormData keys (`upload_id`, `chunk_index`). The `camelToSnake` transform in `client.ts` doesn't apply to FormData bodies.
2. **`media.ts` downloadMedia** — needs `rawResponse: true` (returns raw ArrayBuffer). The `rawResponse` option was also removed from `client.ts` and must be re-added.
3. **`media.ts` both functions** — use `AbortSignal` + `timeout: 60_000` for cancellable large transfers.
4. **`users.ts` uploadAvatar** — uses FormData body + `timeout: 60_000`.
5. **`version.ts` checkVersion** — uses `skipAuth: true` (public endpoint).

## Phase 2 reminders

- Rebuild `deleteExpiredMessages()` or equivalent GC for the Signal envelope cache (`messages` table has `expires_at` column + `idx_messages_expires` partial index ready).
- Add message-related keys back to `FORBIDDEN_PERSISTED_KEYS` in `persistence.test.ts` — decrypted message bodies must never land in MMKV.
- `getPreKeyBundle` in `keys.ts` has no direct unit test (pre-existing gap).
