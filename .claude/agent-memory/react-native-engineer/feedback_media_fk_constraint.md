---
name: media-fk-constraint-retry
description: saveMedia catches FK constraint errors and retries with null thread_id/reply_id/message_id — threads fetched from API are not always persisted to local orbital_threads table
metadata:
  type: feedback
---

`saveMedia()` in `mediaRepository.ts` catches FOREIGN KEY constraint errors and retries the INSERT with null parent IDs (thread_id, reply_id, message_id). This is necessary because threads are fetched from the API but not always persisted to the local SQLite `orbital_threads` table before media metadata arrives. The Zustand store index (setMediaForThread/setMediaForReply) handles the parent mapping in memory, so null DB FKs are safe.

**Why:** Without the retry, media attached to threads that haven't been persisted locally would fail to save entirely, creating data loss on first sync.

**How to apply:** Any new DB save operations that reference parent entities fetched from API should apply the same FK-error-retry-with-null pattern, with the Zustand store maintaining the relationship index.

Related: [[media-display-layer]]
