/**
 * Migration 007: Add archive_confirmed column to orbital_media.
 *
 * Semantics: 1 means no further archive-confirm attempt needed
 * (confirmed / own upload / deleted server-side / left group).
 *
 * Rows start at 0 (unconfirmed). The mediaArchiveConfirmService sweep
 * moves them to 1 after a successful POST /api/media/:id/archive-confirm
 * or when the server returns a terminal status (404/403).
 */

export const VERSION = 7;

export const SQL = `
ALTER TABLE orbital_media ADD COLUMN archive_confirmed INTEGER NOT NULL DEFAULT 0;
`;
