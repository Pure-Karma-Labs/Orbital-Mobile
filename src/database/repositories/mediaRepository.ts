import { queryOne, queryMany, execute } from '../queryHelpers';

// ============================================================
// MediaRow — maps 1:1 to the orbital_media table columns.
// ============================================================

export interface MediaRow {
  id: string;
  thread_id: string | null;
  reply_id: string | null;
  message_id: string | null;
  content_type: string;
  file_name: string | null;
  file_size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  attachment_key: Uint8Array | null;
  attachment_digest: Uint8Array | null;
  cdn_number: number | null;
  cdn_key: string | null;
  local_path: string | null;
  thumbnail_path: string | null;
  blur_hash: string | null;
  expires_at: number | null;
  download_state: string;
  upload_state: string;
  created_at: number;
}

// ============================================================
// Repository functions
// ============================================================

export function saveMedia(row: MediaRow): void {
  execute(
    `INSERT OR REPLACE INTO orbital_media
       (id, thread_id, reply_id, message_id, content_type, file_name, file_size,
        width, height, duration, attachment_key, attachment_digest, cdn_number,
        cdn_key, local_path, thumbnail_path, blur_hash, expires_at,
        download_state, upload_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.thread_id,
      row.reply_id,
      row.message_id,
      row.content_type,
      row.file_name,
      row.file_size,
      row.width ?? null,
      row.height ?? null,
      row.duration ?? null,
      row.attachment_key ?? null,
      row.attachment_digest ?? null,
      row.cdn_number ?? null,
      row.cdn_key ?? null,
      row.local_path ?? null,
      row.thumbnail_path ?? null,
      row.blur_hash ?? null,
      row.expires_at ?? null,
      row.download_state,
      row.upload_state,
      row.created_at,
    ],
  );
}

export function getMedia(id: string): MediaRow | null {
  return queryOne<MediaRow>(
    'SELECT * FROM orbital_media WHERE id = ?',
    [id],
  );
}

export function getMediaForThread(threadId: string): MediaRow[] {
  return queryMany<MediaRow>(
    'SELECT * FROM orbital_media WHERE thread_id = ? ORDER BY created_at ASC',
    [threadId],
  );
}

export function getMediaForReply(replyId: string): MediaRow[] {
  return queryMany<MediaRow>(
    'SELECT * FROM orbital_media WHERE reply_id = ? ORDER BY created_at ASC',
    [replyId],
  );
}

export function updateDownloadState(
  id: string,
  state: string,
  localPath?: string,
): void {
  if (localPath !== undefined) {
    execute(
      'UPDATE orbital_media SET download_state = ?, local_path = ? WHERE id = ?',
      [state, localPath, id],
    );
  } else {
    execute(
      'UPDATE orbital_media SET download_state = ? WHERE id = ?',
      [state, id],
    );
  }
}

export function updateUploadState(id: string, state: string): void {
  execute(
    'UPDATE orbital_media SET upload_state = ? WHERE id = ?',
    [state, id],
  );
}

export function getPendingDownloads(): MediaRow[] {
  return queryMany<MediaRow>(
    "SELECT * FROM orbital_media WHERE download_state = 'pending' ORDER BY created_at ASC",
  );
}

export function deleteMedia(id: string): void {
  execute('DELETE FROM orbital_media WHERE id = ?', [id]);
}
