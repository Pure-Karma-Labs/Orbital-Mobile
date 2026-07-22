/**
 * Migration 008: Drop dead orbital_media_sync_* tables.
 *
 * Dead Route-1 P2P re-share remnants; backend counterparts dropped by
 * Backend migration 043 (#210 PR 4); zero client references.
 *
 * No disableForeignKeys (child-table drops trigger no cascade actions).
 * Fresh installs create-then-drop since 001 is the immutable baseline.
 */

export const VERSION = 8;

export const SQL = `
DROP TABLE IF EXISTS orbital_media_sync_requests;
DROP TABLE IF EXISTS orbital_media_sync_pending_uploads;
`;
