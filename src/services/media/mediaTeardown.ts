/**
 * Shared id-level local media teardown.
 *
 * One media id has THREE local representations — the DB row, the plaintext
 * file on disk, and the Zustand entry — and every path that destroys one must
 * destroy all three in the same order. Two callers need exactly that:
 *   - `mediaUploadService.rollbackOneMedia` (upload rollback, #721/#724),
 *   - `mediaDownloadService.reapOrphanedThumbnailRows` (historical orphan
 *     reaper, #724c).
 *
 * This module is a LEAF: it imports the repository, the DB guard, the store
 * and RNFS, and nothing from the two services that call it, so it introduces
 * no cycle (`src/services/media/` is already imported by both).
 *
 * Deliberately NOT here: resolving which ids to tear down. The upload service's
 * thumbnail-child expansion stays with the rollback that owns it.
 */

import { unlink } from '@dr.pogodin/react-native-fs';
import { deleteMedia } from '../../database/repositories/mediaRepository';
import { isDatabaseInitialized } from '../../database/connection';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Destroy the local half of one media id: DB row, plaintext file, store entry.
 *
 * ORDER IS LOAD-BEARING — deleteMedia runs BEFORE unlink. If the file were
 * unlinked first and deleteMedia then threw, the surviving row would be
 * re-armed for download by `cleanupOrphanedMedia`'s DB pass (it flips a
 * downloaded row whose file is missing back to 'pending', and
 * getPendingDownloadsWithKeys deliberately INCLUDES thumbnails), silently
 * re-materializing the very plaintext frame this teardown exists to destroy.
 * The opposite residue — a file with no row — is harmless and self-heals
 * through that same sweep's no-row branch.
 *
 * @param id Media id to tear down.
 * @param localPath ABSOLUTE plaintext path, or null when nothing is on disk.
 *   Callers resolve this themselves (store-first for rollback, the row's
 *   `local_path` via resolveMediaPath for the reaper) — the raw DB column must
 *   never reach unlink().
 *
 * Best-effort throughout: a teardown failure must never mask the caller's own
 * error.
 */
export async function teardownLocalMedia(
  id: string,
  localPath: string | null,
): Promise<void> {
  if (isDatabaseInitialized()) {
    try {
      deleteMedia(id);
    } catch {
      // Best-effort -- the store removal below still hides the ghost row
    }
  }
  if (localPath) {
    await unlink(localPath).catch(() => {});
  }
  useAppStore.getState().removeMedia(id);
}
