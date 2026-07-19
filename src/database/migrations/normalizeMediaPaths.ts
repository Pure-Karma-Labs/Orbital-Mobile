/**
 * One-shot boot-time normalization pass for legacy absolute media paths.
 *
 * Converts all orbital_media.local_path and thumbnail_path values that start
 * with "/" (legacy absolute paths) to the relative "media/{basename}" form.
 * Idempotent — rows already in relative form are untouched.
 *
 * Called from bootstrap.ts right after runMigrations(). This is a JS-level
 * normalization (not a PRAGMA-versioned SQL migration) because the target
 * form depends on runtime constants that static SQL cannot compute.
 *
 * Per-row try/catch ensures one corrupt row does not block the rest
 * [panel L2].
 */

import { isDatabaseInitialized } from '../connection';
import { queryMany, execute } from '../queryHelpers';
import { toStoredMediaPath } from '../../services/media/mediaPaths';

interface PathRow {
  id: string;
  local_path: string | null;
  thumbnail_path: string | null;
}

/**
 * Normalize legacy absolute media paths to relative form.
 * Safe to call multiple times — no-op when no absolute paths remain.
 */
export function normalizeLegacyMediaPaths(): void {
  if (!isDatabaseInitialized()) return;

  const rows = queryMany<PathRow>(
    "SELECT id, local_path, thumbnail_path FROM orbital_media WHERE local_path LIKE '/%' OR thumbnail_path LIKE '/%'",
  );

  for (const row of rows) {
    try {
      const newLocalPath = row.local_path && row.local_path.startsWith('/')
        ? toStoredMediaPath(row.local_path)
        : row.local_path;
      const newThumbPath = row.thumbnail_path && row.thumbnail_path.startsWith('/')
        ? toStoredMediaPath(row.thumbnail_path)
        : row.thumbnail_path;

      execute(
        'UPDATE orbital_media SET local_path = ?, thumbnail_path = ? WHERE id = ?',
        [newLocalPath, newThumbPath, row.id],
      );
    } catch (e) {
      if (__DEV__) {
        console.warn(
          '[normalizeLegacyMediaPaths] row failed:',
          row.id,
          e instanceof Error ? e.message : e,
        );
      }
      // Per-row resilience — continue with other rows [panel L2]
    }
  }
}
