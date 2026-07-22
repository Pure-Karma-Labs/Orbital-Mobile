import { queryOne, queryMany, execute } from '../queryHelpers';
import { isDatabaseInitialized } from '../connection';

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
  /** Media ID of the thumbnail child row (for video parent rows) */
  thumbnail_media_id?: string | null;
  /** 1 = this row is a thumbnail child; 0 = normal media (default) */
  is_thumbnail?: number;
  /** 1 = no further archive-confirm attempt needed (confirmed / own upload / terminal) */
  archive_confirmed?: number;
}

// ============================================================
// Repository functions
// ============================================================

export function saveMedia(row: MediaRow): void {
  const sql = `INSERT OR REPLACE INTO orbital_media
       (id, thread_id, reply_id, message_id, content_type, file_name, file_size,
        width, height, duration, attachment_key, attachment_digest, cdn_number,
        cdn_key, local_path, thumbnail_path, blur_hash, expires_at,
        download_state, upload_state, created_at, thumbnail_media_id, is_thumbnail,
        archive_confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
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
    row.thumbnail_media_id ?? null,
    row.is_thumbnail ?? 0,
    row.archive_confirmed ?? 0,
  ];

  execute(sql, params);
}

/**
 * Update the thread_id and reply_id on an existing media row.
 *
 * When media is uploaded before the reply/thread is created server-side,
 * the initial media row has NULL parent IDs. This function patches them
 * after the server confirms the reply/thread, so the file library's
 * JOIN chain can resolve conversation_id for orbit filtering.
 */
export function updateMediaParent(
  mediaId: string,
  threadId: string,
  replyId: string | null,
): void {
  if (!isDatabaseInitialized()) return;
  execute(
    'UPDATE orbital_media SET thread_id = ?, reply_id = ? WHERE id = ?',
    [threadId, replyId, mediaId],
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

/**
 * Fetch OP-attached media only; hydrateMediaFromLocal supplements this
 * with reply media via getMediaForThreadReplies to match the server-path
 * aggregation.
 */
export function getThreadLevelMedia(threadId: string): MediaRow[] {
  return queryMany<MediaRow>(
    'SELECT * FROM orbital_media WHERE thread_id = ? AND reply_id IS NULL ORDER BY created_at ASC',
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

/**
 * Fetch all non-thumbnail media rows attached to replies under a given thread.
 * Used by hydrateMediaFromLocal to seed per-reply media indexes on cold start.
 *
 * Returns empty array if database is not initialized.
 */
export function getMediaForThreadReplies(threadId: string): MediaRow[] {
  if (!isDatabaseInitialized()) return [];
  return queryMany<MediaRow>(
    `SELECT m.* FROM orbital_media m
     JOIN orbital_replies r ON m.reply_id = r.id
     WHERE r.thread_id = ? AND COALESCE(m.is_thumbnail, 0) = 0
     ORDER BY m.created_at ASC`,
    [threadId],
  );
}

/**
 * Fetch pending downloads that have both attachment_key and attachment_digest.
 * Oldest first. Excludes failed/unavailable/downloaded rows.
 *
 * Video **parent** rows (content_type LIKE 'video/%' AND is_thumbnail = 0) are
 * excluded — they stay `pending` by design until #458 PR 3's player owns the
 * full-video download path. Video **thumbnails** are unaffected (image/* rows
 * with is_thumbnail=1).
 *
 * Returns empty array if database is not initialized.
 */
export function getPendingDownloadsWithKeys(limit: number): MediaRow[] {
  if (!isDatabaseInitialized()) return [];
  return queryMany<MediaRow>(
    `SELECT * FROM orbital_media
     WHERE download_state = 'pending'
       AND attachment_key IS NOT NULL
       AND attachment_digest IS NOT NULL
       AND NOT (content_type LIKE 'video/%' AND COALESCE(is_thumbnail, 0) = 0)
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit],
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

// ============================================================
// Archive-confirm helpers
// ============================================================

/**
 * Fetch downloaded media rows that have not yet been archive-confirmed.
 * Oldest first. Returns empty array if database is not initialized.
 */
export function getUnconfirmedDownloadedMedia(limit: number): MediaRow[] {
  if (!isDatabaseInitialized()) return [];
  return queryMany<MediaRow>(
    `SELECT * FROM orbital_media
     WHERE download_state = 'downloaded'
       AND COALESCE(archive_confirmed, 0) = 0
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit],
  );
}

/**
 * Mark a single media row as archive-confirmed (no further confirm attempts needed).
 * No-op if database is not initialized.
 */
export function setArchiveConfirmed(id: string): void {
  if (!isDatabaseInitialized()) return;
  execute(
    'UPDATE orbital_media SET archive_confirmed = 1 WHERE id = ?',
    [id],
  );
}

/**
 * Reset all archive_confirmed flags to 0.
 * Used after key recovery when the server has wiped all confirmations.
 * No-op if database is not initialized.
 */
export function clearAllArchiveConfirmations(): void {
  if (!isDatabaseInitialized()) return;
  execute('UPDATE orbital_media SET archive_confirmed = 0');
}

// ============================================================
// File Library queries — paginated, filtered, with JOIN resolution
// ============================================================

/**
 * Options for the paginated file library queries.
 */
export interface GetAllMediaOptions {
  limit: number;
  offset: number;
  sortBy: 'date' | 'size';
  sortOrder: 'asc' | 'desc';
  contentTypeFilter?: 'image' | 'video' | 'document' | null;
  conversationId?: string | null;
}

/** Allowlisted sort columns — only these values are interpolated into SQL. */
const SORT_COLUMNS: Record<string, string> = {
  date: 'm.created_at',
  size: 'm.file_size',
} as const;

/** Allowlisted sort directions — only these values are interpolated into SQL. */
const SORT_DIRS: Record<string, string> = {
  asc: 'ASC',
  desc: 'DESC',
} as const;

/** Type for rows returned from getAllMedia (with resolved conversation_id). */
export type MediaRowWithConversation = MediaRow & { conversation_id: string | null };

/**
 * Build shared WHERE clause fragments and params for getAllMedia/getMediaCount.
 */
function buildMediaFilterClause(options: GetAllMediaOptions): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [
    "m.attachment_key IS NOT NULL",
    "m.upload_state = 'done'",
    "COALESCE(m.is_thumbnail, 0) = 0",
  ];
  const params: (string | number)[] = [];

  // Conversation filter
  if (options.conversationId) {
    conditions.push('COALESCE(t.conversation_id, rt.conversation_id) = ?');
    params.push(options.conversationId);
  }

  // Content type filter
  if (options.contentTypeFilter === 'image') {
    conditions.push("m.content_type LIKE ?");
    params.push('image/%');
  } else if (options.contentTypeFilter === 'video') {
    conditions.push("m.content_type LIKE ?");
    params.push('video/%');
  } else if (options.contentTypeFilter === 'document') {
    conditions.push("m.content_type NOT LIKE 'image/%' AND m.content_type NOT LIKE 'video/%'");
  }

  return {
    where: conditions.join(' AND '),
    params,
  };
}

/**
 * Paginated query for all media with optional filters and sorting.
 * Uses LEFT JOINs to resolve conversation_id from thread or reply parents.
 *
 * Returns empty array if database is not initialized.
 */
export function getAllMedia(options: GetAllMediaOptions): MediaRowWithConversation[] {
  if (!isDatabaseInitialized()) return [];

  const col = SORT_COLUMNS[options.sortBy] ?? 'm.created_at';
  const dir = SORT_DIRS[options.sortOrder] ?? 'DESC';

  const { where, params } = buildMediaFilterClause(options);

  const sql = `
    SELECT m.*, COALESCE(t.conversation_id, rt.conversation_id) as conversation_id
    FROM orbital_media m
    LEFT JOIN orbital_threads t ON m.thread_id = t.id
    LEFT JOIN orbital_replies r ON m.reply_id = r.id
    LEFT JOIN orbital_threads rt ON r.thread_id = rt.id
    WHERE ${where}
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `;

  return queryMany<MediaRowWithConversation>(sql, [...params, options.limit, options.offset]);
}

/**
 * Count of media matching the given filters (same as getAllMedia but without
 * limit/offset/sort).
 *
 * Returns 0 if database is not initialized.
 */
export function getMediaCount(options: GetAllMediaOptions): number {
  if (!isDatabaseInitialized()) return 0;

  const { where, params } = buildMediaFilterClause(options);

  const sql = `
    SELECT COUNT(*) as cnt
    FROM orbital_media m
    LEFT JOIN orbital_threads t ON m.thread_id = t.id
    LEFT JOIN orbital_replies r ON m.reply_id = r.id
    LEFT JOIN orbital_threads rt ON r.thread_id = rt.id
    WHERE ${where}
  `;

  const row = queryOne<{ cnt: number }>(sql, params);
  return row?.cnt ?? 0;
}

/**
 * Total file size in bytes of all locally-downloaded media.
 *
 * Returns 0 if database is not initialized.
 */
export function getLocalStorageUsage(): number {
  if (!isDatabaseInitialized()) return 0;

  const row = queryOne<{ total: number }>(
    "SELECT COALESCE(SUM(file_size), 0) as total FROM orbital_media WHERE download_state = 'downloaded' AND local_path IS NOT NULL",
  );
  return row?.total ?? 0;
}

/**
 * Distinct conversation IDs that have at least one media item.
 *
 * Returns empty array if database is not initialized.
 */
export function getMediaConversationIds(): string[] {
  if (!isDatabaseInitialized()) return [];

  const rows = queryMany<{ conversation_id: string }>(
    `SELECT DISTINCT COALESCE(t.conversation_id, rt.conversation_id) as conversation_id
     FROM orbital_media m
     LEFT JOIN orbital_threads t ON m.thread_id = t.id
     LEFT JOIN orbital_replies r ON m.reply_id = r.id
     LEFT JOIN orbital_threads rt ON r.thread_id = rt.id
     WHERE m.attachment_key IS NOT NULL AND m.upload_state = 'done'
       AND COALESCE(m.is_thumbnail, 0) = 0
       AND COALESCE(t.conversation_id, rt.conversation_id) IS NOT NULL`,
  );

  return rows.map((r) => r.conversation_id);
}
