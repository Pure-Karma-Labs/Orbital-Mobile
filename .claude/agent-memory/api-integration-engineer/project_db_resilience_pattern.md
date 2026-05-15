---
name: project-db-resilience-pattern
description: isDatabaseInitialized() guard pattern for all service-layer DB calls — Metro Fast Refresh resilience
metadata:
  type: project
---

## DB Resilience Pattern (established 2026-05-15)

All database calls in the service layer must be guarded with `isDatabaseInitialized()` from `src/database/connection.ts`. When the check fails, the service should fall through to store-only operation rather than crashing.

**Why:** Metro Fast Refresh during development resets the module-level `let db = null` in `connection.ts` without re-running `initDatabase()`. This means any service function called after a hot reload will find the DB handle null. In production this never happens (initDatabase runs once at bootstrap), but unguarded DB calls crash the entire app during development — making iteration painfully slow.

**How to apply:**
1. Import `isDatabaseInitialized` from `src/database/connection.ts`
2. Call it once at the top of your function: `const dbReady = isDatabaseInitialized();`
3. Wrap every DB read/write in `if (dbReady) { try { ... } catch { ... } }`
4. Design the function to still produce a useful result without DB — typically by relying on the Zustand store alone

### Affected Files

- `src/services/threadService.ts` — `processMediaMetadata` guards `saveMedia()` and `getMedia()`
- `src/services/mediaUploadService.ts` — guards `saveMedia()` and `setGroupMasterKey()`
- Any future service that touches SQLite should follow this pattern

### Non-Production Guard

This is a development-experience pattern. In production, `isDatabaseInitialized()` always returns true after bootstrap. The guard adds no measurable overhead (single boolean check). Do not remove it thinking it's "dead code" — it's load-bearing for DX.

### Related

- [[project-process-media-metadata]] — primary consumer of this pattern
- [[project-media-upload-pipeline]] — also uses this guard for saveMedia
