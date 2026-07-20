/**
 * Media path utilities — shared constants and path resolution.
 *
 * All media files live under ${DocumentDirectoryPath}/media/.
 * DB stores RELATIVE paths ("media/{id}.{ext}"); the Zustand store and all
 * file:// consumers use ABSOLUTE paths resolved at read time. This decouples
 * the persisted path from the iOS container UUID, which rotates on app updates.
 *
 * resolveMediaPath handles both new-relative AND legacy-absolute paths, including
 * rotated-container absolutes where prefix-strip would miss.
 */

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

/** Absolute media directory path (runtime-resolved). */
export const MEDIA_DIR = `${DocumentDirectoryPath}/media`;

/**
 * Convert any path to the stored relative form: "media/{basename}".
 * Returns null for null/undefined input.
 */
export function toStoredMediaPath(absoluteOrRelative: string | null | undefined): string | null {
  if (!absoluteOrRelative) return null;
  const basename = absoluteOrRelative.substring(absoluteOrRelative.lastIndexOf('/') + 1);
  if (!basename) return null;
  return `media/${basename}`;
}

/**
 * Resolve a stored path (relative or legacy-absolute) to the current absolute path.
 *
 * Handles:
 * - null/undefined -> null
 * - New relative: "media/abc.jpg" -> "${MEDIA_DIR}/abc.jpg"
 * - Legacy absolute: "/var/mobile/.../media/abc.jpg" -> "${MEDIA_DIR}/abc.jpg"
 * - Rotated container: "/var/mobile/Containers/.../media/abc.jpg" -> "${MEDIA_DIR}/abc.jpg"
 *
 * Post-resolution containment assertion: if the resolved path does not start
 * with MEDIA_DIR, returns null (defense-in-depth, [panel M1]).
 */
export function resolveMediaPath(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  const basename = storedPath.substring(storedPath.lastIndexOf('/') + 1);
  if (!basename) return null;
  const resolved = `${MEDIA_DIR}/${basename}`;
  // Containment assertion — defense-in-depth [panel M1]
  if (!resolved.startsWith(MEDIA_DIR + '/')) return null;
  return resolved;
}
