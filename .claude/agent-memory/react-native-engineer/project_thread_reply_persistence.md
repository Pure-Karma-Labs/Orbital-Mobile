---
name: thread-reply-persistence
description: SQLCipher persistence for threads/replies — write-through from threadService + WS handlers; local hydration for instant screen loads; dissolved group reconciliation
metadata:
  type: project
---

#345 Phases A+C (PRs #346, #348, merged 2026-06-15) added client-as-archive persistence for threads and replies. Architecture shifted from server-as-archive to Signal-aligned model where threads/replies are permanent on backend (NOT subject to 7-day TTL — that's media only).

**New repositories:**
- `src/database/repositories/threadRepository.ts` — `saveThread`, `saveThreadBatch`, `getThreadsForConversation`, `getThread`, `getConversationIdsWithThreads`, `deleteThread`, `deleteThreadsForConversation`, `clearAllThreads`
- `src/database/repositories/replyRepository.ts` — `saveReply`, `saveReplyBatch`, `getRepliesForThread`, `deleteReply`, `deleteRepliesForThread`, `deleteRepliesForConversation`, `clearAllReplies`

**Migration 004** (`004_thread_reply_persistence.ts`): Rebuilds `orbital_threads` and `orbital_replies` tables without FK constraints (12-step pattern), adds plaintext columns (title, body, author_username, sync_status, depth). `disableForeignKeys: true`.

**Write-through pattern:** Every path that produces a decrypted Thread/Reply persists to SQLCipher:
- `threadService.ts`: `loadThreadsForGroup` (saveThreadBatch), `loadThread` (dbSaveThread), `loadReplies` (saveReplyBatch), `postReply` (dbSaveReply), `createNewThread` (dbSaveThread)
- `messageHandler.ts`: `handleNewThread` (dbSaveThread), `handleNewReply` (dbSaveReply)
- All writes guarded by `isDatabaseInitialized()` + try/catch (best-effort, never blocks UI)

**Local hydration:** `hydrateThreadsFromLocal(conversationId)` and `hydrateRepliesFromLocal(threadId)` in threadService — called synchronously before async API fetch for instant screen loads. Used by ThreadsScreen, ChatDetailScreen, ThreadDetailScreen.

**Timestamp conversion:** DB stores epoch seconds, store uses epoch milliseconds. Convert on write (/ 1000) and read (* 1000).

**Dissolved group cleanup:** `loadConversations()` in conversationService reconciles local threads/replies against server groups. Groups no longer returned by server get their local cache purged in a single transaction.

**Wipe integration:** `localWipe()` in authService calls `clearAllThreads()` + `clearAllReplies()` (best-effort).

**Why:** Instant screen loads from local cache; offline viewing of previously-seen content; foundation for FTS5 search.

**How to apply:** Any new code path that produces decrypted threads/replies must write-through to the DB. Use `isDatabaseInitialized()` guard + try/catch. Screens should call hydrate functions before async API loads for instant UI.

Related: [[search-filtering]], [[media-fk-constraint-retry]]
