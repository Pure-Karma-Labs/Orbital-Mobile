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

/**
 * A media row with its author resolved through the parent it hangs off (#897).
 *
 * `author_id` is NULL when the parent row is not on this device (the LEFT JOIN
 * found nothing) — the fail-open case every author filter shares.
 */
export type MediaRowWithAuthor = MediaRow & { author_id: string | null };

/**
 * Fetch OP-attached media only; hydrateMediaFromLocal supplements this
 * with reply media via getMediaForThreadReplies to match the server-path
 * aggregation.
 *
 * Carries the THREAD's author (#897) so the hydrate path can drop a blocked
 * author's cached media. `reply_id IS NULL` is the thread-author fallback the
 * issue asks for: reply media first seen via thread detail sits with a NULL
 * `reply_id` until the `updateMediaParent` backfill runs, and those rows are
 * attributed to the thread author rather than to nobody.
 *
 * KNOWN RESIDUE, documented rather than fixed in #897: that fallback leaves a
 * gap. `/replies` does NOT drop a blocked author's replies — its recursive
 * reply CTE (`Orbital-Backend/src/routes/threads.js`) carries no `user_blocks`
 * clause, so the reply ROW still comes back; only the media query beside it is
 * block-filtered, so the row arrives with `media: []`. Three consequences:
 *
 *   1. With no media on the row, `mapReplyResponse` (`threadService.ts`) never
 *      calls `processMediaMetadata` for that reply, so the `updateMediaParent`
 *      backfill never runs for it. Its cached media keeps `reply_id NULL` and
 *      the JOIN below attributes it to the THREAD author, who is not blocked.
 *   2. `reconcileThreadReplies` never deletes a blocked author's replies
 *      either — the server still lists their ids, so they land in the keep-set
 *      and neither the rows nor their media are ever torn down.
 *   3. It is reachable on ANY thread whose replies span more than one page, not
 *      only on rows cached BEFORE the block: `loadThread` hands the whole
 *      thread `media[]` to `processMediaMetadata` with `{ threadId }`, so every
 *      row is saved with `reply_id NULL`, and only a FETCHED page of `/replies`
 *      backfills the parent of the rows it covers.
 *
 * Closing it needs an author column on `orbital_media`, i.e. a schema
 * migration, which is out of scope for #897.
 */
export function getThreadLevelMedia(threadId: string): MediaRowWithAuthor[] {
  return queryMany<MediaRowWithAuthor>(
    `SELECT m.*, t.author_id AS author_id
     FROM orbital_media m
     LEFT JOIN orbital_threads t ON m.thread_id = t.id
     WHERE m.thread_id = ? AND m.reply_id IS NULL
     ORDER BY m.created_at ASC`,
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
 * Fetch all non-thumbnail media rows attached to replies under a given thread,
 * each with its REPLY's author (#897) so the hydrate path can drop a blocked
 * author's cached media. The INNER JOIN it already needed carries the column;
 * `idx_media_thread` / `idx_replies_thread` still serve the query.
 *
 * Used by hydrateMediaFromLocal to seed per-reply media indexes on cold start.
 *
 * Returns empty array if database is not initialized.
 */
export function getMediaForThreadReplies(threadId: string): MediaRowWithAuthor[] {
  if (!isDatabaseInitialized()) return [];
  return queryMany<MediaRowWithAuthor>(
    `SELECT m.*, r.author_id AS author_id FROM orbital_media m
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
 * excluded — they stay `pending` by design. The MediaLightbox player is the
 * sole trigger for full-video download, one video at a time, only while its
 * page is on screen (#458 PR 3); this exclusion from the bulk/prefetch path
 * is permanent, not a stepping stone. Video **thumbnails** are unaffected
 * (image/* rows with is_thumbnail=1). Streaming decrypt and eviction of
 * downloaded video bytes remain deferred to #578.
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
  /**
   * The viewer's own per-viewer author exclusion (#897) — normally
   * `blockedUserIds`. ONE channel, applied by every list surface that uses
   * this builder: the File Library grid, the gallery hydrate path and the
   * bulk-export snapshot.
   *
   * REQUIRED, and `[]` means "exclude nobody" (#906 review). It is required
   * precisely because it is a filter whose omission is silent: an optional
   * field lets a new list surface forget it and ship a grid that shows a
   * blocked author's media, with nothing failing. An empty array emits no
   * clause at all, so the SQL is unchanged for callers that have nobody
   * blocked.
   */
  excludeAuthorIds: readonly string[];
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
 * The membership facts — and since #897 ONLY the membership facts — that a
 * BULK export narrows its snapshot by (#878 PR 2).
 *
 * `conversationIds` are the keys of the store's `conversations` map — the
 * store, not SQL, is the membership authority (DMs are threads and live in the
 * same map; the SQLite `conversations` table is a group-key store that keeps
 * rows for orbits you have left). Passing it in keeps this repository free of
 * a store import.
 *
 * The blocked-author exclusion used to ride here too, as `blockedAuthorIds`.
 * It moved to `GetAllMediaOptions.excludeAuthorIds` in #897 because it is no
 * longer bulk-only: every list surface applies it, so it belongs on the
 * options every surface already passes.
 */
export interface MediaExportAccessFilter {
  /** Conversations the signed-in user is currently in. Empty ⇒ nothing. */
  conversationIds: readonly string[];
}

/** SQL for the row's author, picked by whichever parent it actually hangs off. */
const AUTHOR_EXPR =
  'CASE WHEN m.reply_id IS NOT NULL THEN r.author_id ELSE t.author_id END';

/**
 * Build shared WHERE clause fragments and params for getAllMedia/getMediaCount
 * and the bulk-export snapshot.
 *
 * `access` is OPTIONAL and only the bulk path passes it. The grid deliberately
 * does NOT apply it: leaving an orbit leaves its `orbital_media` rows behind,
 * and those orphans keep showing under "All Orbits" (Alex 2026-10-09) — the
 * alternative hides media from orbits you have left. `excludeAuthorIds`
 * (#897) is the opposite: it travels on `options`, so EVERY caller applies it.
 *
 * Returns `null` when `access` is present with an EMPTY conversation list. That
 * is not the same as "no conversation filter": an `IN ()` is a syntax error in
 * SQLite, and a silently dropped clause would return the whole library to a
 * caller that asked for nothing. Callers short-circuit on null and run no
 * query at all.
 */
function buildMediaFilterClause(
  options: GetAllMediaOptions,
  access?: MediaExportAccessFilter,
): {
  where: string;
  params: (string | number)[];
} | null {
  const conditions: string[] = [
    "m.attachment_key IS NOT NULL",
    "m.upload_state = 'done'",
    "COALESCE(m.is_thumbnail, 0) = 0",
  ];
  const params: (string | number)[] = [];

  if (access) {
    if (access.conversationIds.length === 0) return null;
    const convPlaceholders = access.conversationIds.map(() => '?').join(', ');
    conditions.push(
      `COALESCE(t.conversation_id, rt.conversation_id) IN (${convPlaceholders})`,
    );
    params.push(...access.conversationIds);
  }

  // Author exclusion — OUTSIDE the access block (#897). It is the viewer's own
  // per-viewer filter and applies to every list surface, grid included; the
  // membership `IN` above stays access-only so orphaned rows keep showing
  // under "All Orbits" (Alex 2026-10-09). Only emitted when there IS someone
  // excluded: an always-present `NOT IN ('')` would read as a pin on a
  // behaviour that is off by default.
  const excludeAuthorIds = options.excludeAuthorIds;
  if (excludeAuthorIds.length > 0) {
    const authorPlaceholders = excludeAuthorIds.map(() => '?').join(', ');
    // COALESCE: `NULL NOT IN (…)` evaluates to NULL, which filters the row
    // OUT — so an author-less row would silently vanish from the list.
    conditions.push(`COALESCE(${AUTHOR_EXPR}, '') NOT IN (${authorPlaceholders})`);
    params.push(...excludeAuthorIds);
  }

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

  const clause = buildMediaFilterClause(options);
  if (clause === null) return [];
  const { where, params } = clause;

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
 * The optional `access` argument is what lets the bulk-export confirm Alert
 * say how many items "can't be saved": the difference between the count
 * WITHOUT it (what the grid shows) and WITH it (what a batch may touch).
 * Since #897 that delta is ORPHANS ONLY — rows whose conversation JOIN
 * resolves to NULL. Blocked authors no longer contribute to it: their
 * exclusion rides on `options.excludeAuthorIds`, which both sides of the
 * subtraction already carry.
 *
 * Returns 0 if database is not initialized, or if `access` admits no
 * conversation at all.
 */
export function getMediaCount(
  options: GetAllMediaOptions,
  access?: MediaExportAccessFilter,
): number {
  if (!isDatabaseInitialized()) return 0;

  const clause = buildMediaFilterClause(options, access);
  if (clause === null) return 0;
  const { where, params } = clause;

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

// ============================================================
// Export access (#878)
// ============================================================

/**
 * The three facts the export path needs to decide whether an item may be
 * saved to the device.
 *
 * `conversation_id` is NULL for an orphan: leaving an orbit deletes its
 * threads and replies but leaves `orbital_media` rows behind, so the JOIN
 * resolves to nothing. It is also NULL for the uploader's own row before the
 * post it belongs to exists.
 *
 * `author_id` resolves through whichever parent the row actually hangs off —
 * a reply's author for reply media, the thread's author otherwise. It feeds
 * the per-item `isBlockedAuthor` re-checks in `mediaExportService`, which
 * since #897 exist only to catch a block landing MID-RUN: the lists themselves
 * now exclude blocked authors via `GetAllMediaOptions.excludeAuthorIds`, which
 * retired the "saveable one at a time" carve-out of 2026-10-09. A NULL author
 * stays fail-open.
 */
export interface MediaExportAccess {
  conversation_id: string | null;
  author_id: string | null;
}

/**
 * Resolve one media row's export access facts, or null when the row does not
 * exist (or the DB is not open).
 *
 * This is the SERVICE-SIDE re-check, run before and after the download. The
 * lightbox does not call it — exportability reaches the lightbox as a
 * host-supplied `canExport` prop, so there is no async DB query in the UI.
 */
export function getMediaExportAccess(id: string): MediaExportAccess | null {
  if (!isDatabaseInitialized()) return null;

  return queryOne<MediaExportAccess>(
    `SELECT COALESCE(t.conversation_id, rt.conversation_id) as conversation_id,
            ${AUTHOR_EXPR} as author_id
     FROM orbital_media m
     LEFT JOIN orbital_threads t ON m.thread_id = t.id
     LEFT JOIN orbital_replies r ON m.reply_id = r.id
     LEFT JOIN orbital_threads rt ON r.thread_id = rt.id
     WHERE m.id = ?`,
    [id],
  );
}

/**
 * One row of a bulk-export snapshot — the five facts a batch needs and nothing
 * else (#878 PR 2).
 *
 * Deliberately NOT `MediaRow`: the runner must never hold a `file_name`, an
 * `attachment_key` or a `local_path`. It passes ids back into
 * `mediaExportService`, which re-reads the row and is the only module that
 * handles a peer-supplied name or a decrypted path.
 *
 * `has_local` is 1/0 rather than a boolean because it comes straight out of
 * SQLite, which has no boolean type.
 */
export interface MediaExportSnapshotRow {
  id: string;
  content_type: string;
  file_size: number;
  download_state: string;
  has_local: number;
}

/**
 * Every item a "Save all" run would touch, under the SAME filters and sort the
 * grid is showing, narrowed to what the user may actually export.
 *
 * Bounded by `limit` (the caller passes `BULK_EXPORT_MAX_ITEMS`): the run is
 * the iterated set, so the bound is also the bound on the single iOS document
 * picker at the end of a run.
 *
 * Returns an empty array — running NO query — when the database is closed or
 * `access` admits no conversation. Synchronous, like every other function in
 * this repository; the caller takes an await tick first so the tap can render
 * its disabled button state before the DB work starts (`prepareBulkExport`).
 */
export function getExportSnapshot(
  options: GetAllMediaOptions,
  access: MediaExportAccessFilter,
  limit: number,
): MediaExportSnapshotRow[] {
  if (!isDatabaseInitialized()) return [];

  const clause = buildMediaFilterClause(options, access);
  if (clause === null) return [];
  const { where, params } = clause;

  const col = SORT_COLUMNS[options.sortBy] ?? 'm.created_at';
  const dir = SORT_DIRS[options.sortOrder] ?? 'DESC';

  const sql = `
    SELECT m.id, m.content_type, m.file_size, m.download_state,
           CASE WHEN m.local_path IS NOT NULL THEN 1 ELSE 0 END as has_local
    FROM orbital_media m
    LEFT JOIN orbital_threads t ON m.thread_id = t.id
    LEFT JOIN orbital_replies r ON m.reply_id = r.id
    LEFT JOIN orbital_threads rt ON r.thread_id = rt.id
    WHERE ${where}
    ORDER BY ${col} ${dir}
    LIMIT ?
  `;

  return queryMany<MediaExportSnapshotRow>(sql, [...params, limit]);
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
