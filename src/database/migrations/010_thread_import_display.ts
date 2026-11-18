export const VERSION = 10;

// Migration 010: Meta-import display fields on orbital_threads (#927)
//
// The read path carries three new facts per thread, so a cold, offline launch
// hydrates an imported row the same way a fetch does:
//
//  - `is_import`    the server's derived flag (Backend #317), 0 or 1. It drives
//                   the row badge, the detail caption and the read state, so a
//                   cached row that lost it would show an unread dot next to an
//                   orbit badge of 0 until the next fetch.
//  - `import_source` the label from the opened import-meta envelope
//                   ('facebook' | 'instagram'), NULL when unknown. DISPLAY
//                   ONLY — the envelope's AAD binds the orbit, not the thread.
//  - `media_count`  the server's per-viewer count, NULL = unknown. Feeds the
//                   display-time headline for a title-less post only.
//
// No `import_id` column: its FK is ON DELETE SET NULL server-side, nothing in
// this client reads it, and `is_import` is the lasting flag. No date column
// either — the displayed date is the served `created_at`, and the envelope's
// `originalCreatedAt` is never read on this side.
//
// FORWARD-ONLY, and deliberately three ALTERs rather than a table rebuild: the
// 005 FTS5 triggers hang off orbital_threads, and a rebuild would have to drop
// and recreate them. `ALTER TABLE ... ADD COLUMN` leaves them in place.
// Existing rows take the defaults (0 / NULL / NULL) and correct themselves on
// the first fetch of their orbit, so no backfill is needed and the runner does
// NOT set `disableForeignKeys` (no rebuild, no FK to re-check).
//
// No CHECK constraints, matching 001-009: `mapRowToThread` validates on read
// (an unknown source reads back as NULL), and a CHECK would force a rebuild
// under forward-only migrations if the source enum ever grows.

export const SQL = `
ALTER TABLE orbital_threads ADD COLUMN is_import INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orbital_threads ADD COLUMN import_source TEXT;
ALTER TABLE orbital_threads ADD COLUMN media_count INTEGER;
`;
