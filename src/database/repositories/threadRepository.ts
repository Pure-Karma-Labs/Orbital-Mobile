/**
 * Thread persistence repository — CRUD operations on orbital_threads.
 *
 * Stores decrypted thread data (title, body, author_username) for local
 * hydration and offline viewing. Encrypted blob columns are left NULL;
 * decryption happens in the service layer before data reaches here.
 *
 * Timestamps: epoch MILLISECONDS in both the DB and the store since #844
 * (orbital_replies made the same move in #821). Rows written before that hold
 * epoch seconds and persist indefinitely (no migration; only server-returned
 * threads are rewritten); mapRowToThread reads either via toMillis (see
 * ../timestampUnits). Never add a WHERE / LIMIT / OFFSET range predicate on
 * these columns without a backfill migration first.
 */

import { queryOne, queryMany, execute } from '../queryHelpers';
import { getDatabase } from '../connection';
import { isDatabaseInitialized } from '../connection';
import { toMillis } from '../timestampUnits';
import type { Thread } from '../../types/store';

// ============================================================
// Write operations
// ============================================================

/**
 * Insert or replace a thread row. Writes plaintext columns only;
 * encrypted blob columns are left NULL.
 */
export function saveThread(thread: Thread): void {
  if (!isDatabaseInitialized()) return;

  // The three import-display columns (migration 010, #927) are APPENDED at
  // positions 14-16, after sync_status — the order every existing column sits
  // in is load-bearing for the positional params below.
  const sql = `INSERT OR REPLACE INTO orbital_threads
    (id, conversation_id, author_id, title, body, author_username,
     content_type, pinned, reply_count, last_reply_at,
     created_at, updated_at, sync_status,
     is_import, import_source, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    thread.id,
    thread.conversationId,
    thread.authorId,
    thread.title ?? null,
    thread.body ?? null,
    thread.authorUsername,
    thread.contentType,
    thread.pinned ? 1 : 0,
    thread.replyCount,
    thread.lastReplyAt != null ? Math.floor(thread.lastReplyAt) : null,
    Math.floor(thread.createdAt),
    Math.floor(thread.updatedAt),
    thread.syncStatus,
    thread.isImport ? 1 : 0,
    thread.importSource ?? null,
    thread.mediaCount != null ? Math.floor(thread.mediaCount) : null,
  ];

  execute(sql, params);
}

/**
 * Batch-insert threads in a single transaction.
 * Uses BEGIN IMMEDIATE / COMMIT with ROLLBACK on error.
 */
export function saveThreadBatch(conversationId: string, threads: Thread[]): void {
  if (!isDatabaseInitialized() || threads.length === 0) return;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const thread of threads) {
      // Ensure all threads in the batch belong to the declared conversation
      const t = thread.conversationId === conversationId ? thread : { ...thread, conversationId };
      saveThread(t);
    }
    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }
}

// ============================================================
// Read operations
// ============================================================

interface ThreadRow {
  id: string;
  conversation_id: string;
  author_id: string;
  title: string | null;
  body: string | null;
  author_username: string | null;
  content_type: string;
  pinned: number;
  reply_count: number;
  /** Epoch ms since #844; legacy rows hold seconds — read via toMillis. */
  last_reply_at: number | null;
  /** Epoch ms since #844; legacy rows hold seconds — read via toMillis. */
  created_at: number;
  /** Epoch ms since #844; legacy rows hold seconds — read via toMillis. */
  updated_at: number;
  sync_status: string;
  /** Migration 010; absent on a row read from a pre-010 cache. */
  is_import?: number | null;
  /** Migration 010; 'facebook' | 'instagram', else unknown. */
  import_source?: string | null;
  /** Migration 010; NULL = unknown count. */
  media_count?: number | null;
}

/** The two values {@link Thread.importSource} may hold. Anything else is NULL. */
const IMPORT_SOURCES: readonly string[] = ['facebook', 'instagram'];

function mapRowToThread(row: ThreadRow): Thread {
  // Validate on READ rather than with a CHECK constraint (see migration 010).
  // A pre-010 row has none of these columns at all, so every branch has to
  // survive `undefined` as well as a junk value: such a row hydrates as
  // non-import with an unknown count and corrects on the next fetch.
  const mediaCount =
    typeof row.media_count === 'number' &&
    Number.isInteger(row.media_count) &&
    row.media_count >= 0
      ? row.media_count
      : null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    authorUsername: row.author_username ?? '',
    title: row.title,
    body: row.body,
    contentType: (row.content_type as Thread['contentType']) || 'text',
    pinned: row.pinned === 1,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at != null ? toMillis(row.last_reply_at) : null,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    syncStatus: (row.sync_status as Thread['syncStatus']) || 'synced',
    isImport: row.is_import === 1,
    importSource:
      typeof row.import_source === 'string' && IMPORT_SOURCES.includes(row.import_source)
        ? (row.import_source as Thread['importSource'])
        : null,
    mediaCount,
  };
}

/**
 * Get all threads for a conversation.
 *
 * Rows may mix legacy epoch-seconds with ms (#844), so this SQL order is only
 * a hint — callers re-sort by the mapped ms value (threadsSlice.setThreads).
 * Do NOT add LIMIT/OFFSET or any WHERE on created_at here without normalising
 * the unit first.
 *
 * NO production caller since #923 moved hydration to the bounded read — KEEP
 * IT: the unbounded read is what a decision needs (pruning reconciles against
 * every cached row, #923 PR B), and this docstring is where the no-LIMIT rule
 * lives. Deleting it would leave only the bounded variant and invite the next
 * caller to bound a read that must not be bounded.
 *
 * Returns empty array if database is not initialized.
 */
export function getThreadsForConversation(conversationId: string): Thread[] {
  if (!isDatabaseInitialized()) return [];

  const rows = queryMany<ThreadRow>(
    'SELECT * FROM orbital_threads WHERE conversation_id = ? ORDER BY created_at DESC',
    [conversationId],
  );

  return rows.map(mapRowToThread);
}

/**
 * The most recent `limit` threads for a conversation — the PRE-NETWORK
 * placeholder `hydrateThreadsFromLocal` paints before the list request lands
 * (#923).
 *
 * WHY A `LIMIT` IS SAFE HERE AND NOWHERE ELSE. The file-level rule (and the
 * one on {@link getThreadsForConversation}) forbids LIMIT/OFFSET/WHERE on
 * these columns because rows written before #844 hold epoch SECONDS, so the
 * raw SQL order is a hint rather than the mapped order: a seconds value is
 * ~1000x smaller than a ms one, which puts every legacy row at the END of
 * `ORDER BY created_at DESC`. A LIMIT therefore cuts exactly the rows that
 * would sort last anyway — and in a read whose entire output is replaced by
 * the server's own page a moment later. Nothing is reconciled, deleted or
 * counted from this result; it exists so the screen is not blank.
 *
 * Any read that DECIDES something (pruning, reconciliation, export) must keep
 * using the unbounded one and bound itself on the mapped ms value.
 *
 * Returns empty array if database is not initialized.
 */
export function getRecentThreadsForConversation(
  conversationId: string,
  limit: number,
): Thread[] {
  if (!isDatabaseInitialized()) return [];
  // A non-positive or non-finite limit would otherwise become `LIMIT -1`
  // (SQLite: no limit at all), silently restoring the unbounded read.
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const rows = queryMany<ThreadRow>(
    'SELECT * FROM orbital_threads WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [conversationId, Math.floor(limit)],
  );

  return rows.map(mapRowToThread);
}

/**
 * How many ids one `getThreadsByIds` statement binds.
 *
 * SQLite's compile-time `SQLITE_MAX_VARIABLE_NUMBER` is 999 on the older
 * builds this app has shipped against; 200 keeps a wide margin and keeps each
 * statement's string short enough to parse cheaply.
 */
const ID_CHUNK_SIZE = 200;

/**
 * Read a set of threads by id, in chunks (#923).
 *
 * Two callers, both batching a read that used to be per-row: the thread-list
 * page pipeline's recency fallback (one query per page instead of one per row
 * that is not already in the store) and the search path, which has to reach
 * rows the entity map no longer holds after a trim.
 *
 * Ids are de-duplicated; unknown ids are simply absent from the result, which
 * is never longer than `ids`. Order is NOT guaranteed — callers index the
 * result by id.
 */
export function getThreadsByIds(ids: readonly string[]): Thread[] {
  if (!isDatabaseInitialized()) return [];

  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  const out: Thread[] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = queryMany<ThreadRow>(
      `SELECT * FROM orbital_threads WHERE id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) out.push(mapRowToThread(row));
  }

  return out;
}

/**
 * Get a single thread by ID.
 * Returns null if not found or database is not initialized.
 */
export function getThread(id: string): Thread | null {
  if (!isDatabaseInitialized()) return null;

  const row = queryOne<ThreadRow>(
    'SELECT * FROM orbital_threads WHERE id = ?',
    [id],
  );

  return row ? mapRowToThread(row) : null;
}

/**
 * Get distinct conversation IDs that have at least one persisted thread.
 * Used for reconciliation (detecting dissolved groups).
 */
export function getConversationIdsWithThreads(): string[] {
  if (!isDatabaseInitialized()) return [];

  const rows = queryMany<{ conversation_id: string }>(
    'SELECT DISTINCT conversation_id FROM orbital_threads',
  );

  return rows.map((r) => r.conversation_id);
}

// ============================================================
// Delete operations
// ============================================================

export function deleteThread(id: string): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_threads WHERE id = ?', [id]);
}

export function deleteThreadsForConversation(conversationId: string): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_threads WHERE conversation_id = ?', [conversationId]);
}

export function clearAllThreads(): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_threads');
}
