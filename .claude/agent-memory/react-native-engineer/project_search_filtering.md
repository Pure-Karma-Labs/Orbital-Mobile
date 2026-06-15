---
name: search-filtering
description: FTS5 full-text search via SQLCipher; useSQLiteSearch hook replaced useFuseSearch; searchRepository + thread_fts/reply_fts virtual tables
metadata:
  type: project
---

#345 (closed 2026-06-15) expanded search from in-memory Fuse.js to database-backed FTS5 full-text search across thread/reply content.

**Phase C (PR #348)** replaced Fuse.js with FTS5:
- `src/database/repositories/searchRepository.ts` — `sanitizeFtsQuery(input)` wraps in escaped double-quotes to prevent FTS5 parse errors; `searchAll(conversationId, query)` queries `thread_fts` + `reply_fts`, returns deduplicated thread IDs (thread matches first, then reply-surfaced parents)
- `src/hooks/useSQLiteSearch.ts` — debounced hook mirroring useFuseSearch API: `{searchText, setSearchText, resultThreadIds, isSearching, clearSearch}`. `isSearching` derived from debounced text (not raw) to avoid day-grouping flash.
- `src/database/migrations/005_fts5_search.ts` — FTS5 virtual tables (`thread_fts`, `reply_fts`) with auto-sync triggers (INSERT/UPDATE/DELETE) and backfill from existing data
- FTS5 enabled via `"fts5": true` in `package.json` op-sqlite config section (requires native rebuild)
- ThreadsScreen and ChatDetailScreen now use `useSQLiteSearch` instead of `useFuseSearch`
- SearchBar + SearchEmptyState components reused (unchanged)

**Still in codebase (not removed):**
- `useFuseSearch` hook, `getCachedFuseIndex`, `fuse.js` dependency — still used for DM conversation filtering in ChatsListScreen
- Metro CJS-first resolverMainFields fix remains needed for fuse.js

**Why:** Fuse.js only searched in-memory store data (titles, usernames). FTS5 searches persisted decrypted content (thread bodies, reply bodies) for true message content search.

**How to apply:** For thread/reply search, use `useSQLiteSearch`. For non-persisted list filtering (DM names, orbit names), `useFuseSearch` is still appropriate. Any new FTS5 content requires adding triggers to keep virtual tables in sync. Always use `sanitizeFtsQuery` for user input — never pass raw strings to FTS5 MATCH.

Related: [[thread-reply-persistence]]
