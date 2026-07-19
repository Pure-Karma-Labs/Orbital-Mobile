/**
 * Media data mappers — pure functions to convert between database rows and store types.
 *
 * Extracted from threadService.ts to allow reuse across the codebase without
 * pulling in the full crypto/API dependency chain.
 */

import type { MediaRow } from './mediaRepository';
import type { MediaItem } from '../../types/store';
import { resolveMediaPath } from '../../services/media/mediaPaths';

/**
 * Normalize attachment_key from DB to a boolean indicating presence.
 * Handles Uint8Array (normal), ArrayBuffer (edge), and string (base64 legacy).
 */
export function normalizeAttachmentKey(
  key: Uint8Array | ArrayBuffer | string | null | undefined,
): boolean {
  if (key == null) return false;
  if (key instanceof Uint8Array) return key.byteLength > 0;
  if (key instanceof ArrayBuffer) return key.byteLength > 0;
  if (typeof key === 'string') return key.length > 0;
  return false;
}

/** Convert a MediaRow (DB) to a MediaItem (store). */
export function mediaRowToItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    replyId: row.reply_id,
    contentType: row.content_type,
    fileName: row.file_name,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    blurHash: row.blur_hash,
    localPath: resolveMediaPath(row.local_path),
    thumbnailPath: resolveMediaPath(row.thumbnail_path),
    downloadState: (row.download_state as MediaItem['downloadState']) ?? 'pending',
    uploadState: (row.upload_state as MediaItem['uploadState']) ?? 'pending',
    expiresAt: row.expires_at,
    hasKeys: normalizeAttachmentKey(row.attachment_key),
    thumbnailMediaId: row.thumbnail_media_id ?? null,
    isThumbnail: (row.is_thumbnail ?? 0) === 1,
  };
}
