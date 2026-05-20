---
name: project-fk-constraint-followup
description: FK constraints on orbital_media.thread_id cause errors because threads aren't persisted locally; follow-up #149 will drop them
metadata:
  type: project
---

## FK Constraint Issue on orbital_media

Local SQLCipher schema has foreign key constraints:
- `orbital_media.thread_id REFERENCES orbital_threads(id) ON DELETE SET NULL`
- `orbital_media.reply_id REFERENCES orbital_replies(id) ON DELETE SET NULL`

But parent rows in `orbital_threads` and `orbital_replies` are not always persisted locally — the app receives media metadata from the server before (or without) persisting the thread/reply rows.

### Current Mitigation

`saveMedia()` in `src/database/repositories/mediaRepository.ts` catches FK constraint errors and retries the INSERT with null foreign keys. The Zustand store (`useMediaStore`) handles parent-child mapping via its own index, so the null FKs in SQLCipher don't break any application logic.

### Follow-up

Issue #149 will drop the FK constraints entirely via a schema migration. This is the correct long-term fix — the FK constraints provide no value when parent rows are managed externally (Zustand store) and threads/replies flow through different sync paths than media.

**Why:** FK errors on media save cause unnecessary error-path execution and make the code harder to reason about. The retry-with-null-FKs workaround is safe but adds complexity.
**How to apply:** Until #149 lands, any new FK references added to `orbital_media` (or similar patterns where parent rows may not exist locally) should be flagged. After #149, verify the migration drops the constraints cleanly without data loss.
