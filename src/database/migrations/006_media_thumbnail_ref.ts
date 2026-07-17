/**
 * Migration 006: Add thumbnail reference columns to orbital_media.
 *
 * Adds:
 * - thumbnail_media_id TEXT: references the media ID of the thumbnail child row
 * - is_thumbnail INTEGER NOT NULL DEFAULT 0: marks child rows (1) vs parent rows (0)
 *
 * is_thumbnail=1 rows are excluded from library queries so thumbnail children
 * never appear as orphan images in the file library.
 *
 * Note: duration (MILLISECONDS) was established in migration 001. Envelope sends
 * duration in seconds (float); callers must Math.round(seconds*1000) before DB insert.
 */

export const VERSION = 6;

export const SQL = `
ALTER TABLE orbital_media ADD COLUMN thumbnail_media_id TEXT;
ALTER TABLE orbital_media ADD COLUMN is_thumbnail INTEGER NOT NULL DEFAULT 0;
`;
