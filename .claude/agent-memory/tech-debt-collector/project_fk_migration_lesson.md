---
name: fk-migration-lesson
description: SQLite FK drop requires PRAGMA foreign_keys=OFF (not defer_foreign_keys) because DROP TABLE triggers CASCADE with FKs enabled
metadata:
  type: project
---

When dropping foreign key constraints via SQLite's 12-step table rebuild pattern (CREATE new table, INSERT INTO new, DROP old, RENAME), you MUST use `PRAGMA foreign_keys = OFF` before the transaction, not `PRAGMA defer_foreign_keys = ON`.

**Why:** `defer_foreign_keys` only defers constraint _checking_ until COMMIT. It does NOT prevent `DROP TABLE` from triggering CASCADE/SET NULL actions on child tables while `foreign_keys` is ON. The DROP TABLE itself causes SQLite to execute the FK enforcement actions (deleting or nullifying rows in dependent tables), which destroys data before the RENAME completes.

**How to apply:** The migration runner now has a `disableForeignKeys` flag (see `src/database/migrations/index.ts`). Migrations that use the table rebuild pattern (like `003_drop_media_fks.ts`) set this flag. The runner issues `PRAGMA foreign_keys = OFF` before the transaction, then re-enables and runs `PRAGMA foreign_key_check` after COMMIT. Any future table rebuild migrations should use this same flag.

Related: [[debt-registry]] (FK migration resolved entry)
