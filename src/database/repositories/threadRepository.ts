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

  const sql = `INSERT OR REPLACE INTO orbital_threads
    (id, conversation_id, author_id, title, body, author_username,
     content_type, pinned, reply_count, last_reply_at,
     created_at, updated_at, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
}

function mapRowToThread(row: ThreadRow): Thread {
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
