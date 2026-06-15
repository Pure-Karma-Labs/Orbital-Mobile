---
name: media-fk-constraint-retry
description: saveMedia catches FK errors and retries with null parent IDs; orbital_threads/replies FKs now dropped (migration 004) but media table FKs may still be active
metadata:
  type: feedback
---

`saveMedia()` in `mediaRepository.ts` catches FOREIGN KEY constraint errors and retries the INSERT with null parent IDs (thread_id, reply_id, message_id). The Zustand store index (setMediaForThread/setMediaForReply) handles the parent mapping in memory, so null DB FKs are safe.

Note: Migration 004 (PR #346, 2026-06-15) dropped FK constraints on `orbital_threads` and `orbital_replies` using the 12-step table rebuild pattern. Media table FKs were already dropped in migration 003. FK constraints are now fully eliminated across all content tables.

**Why:** Out-of-order WS data (thread before conversation row, media before thread row) caused FK INSERT failures.

**How to apply:** FK constraints have been removed from all content tables. New tables should NOT add FK constraints on content entity references — use application-level consistency + reconciliation instead (see dissolved group cleanup in conversationService).

Related: [[thread-reply-persistence]]
