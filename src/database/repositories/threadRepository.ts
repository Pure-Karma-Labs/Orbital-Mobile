/**
 * Thread persistence repository — CRUD operations on orbital_threads.
 *
 * Stores decrypted thread data (title, body, author_username) for local
 * hydration and offline viewing. Encrypted blob columns are left NULL;
 * decryption happens in the service layer before data reaches here.
 *
 * Timestamps: DB stores epoch seconds, store uses epoch milliseconds.
 * Convert on write (/ 1000) and read (* 1000).
 */

import { queryOne, queryMany, execute } from '../queryHelpers';
import { getDatabase } from '../connection';
import { isDatabaseInitialized } from '../connection';
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
    thread.lastReplyAt != null ? Math.floor(thread.lastReplyAt / 1000) : null,
    Math.floor(thread.createdAt / 1000),
    Math.floor(thread.updatedAt / 1000),
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
  last_reply_at: number | null;
  created_at: number;
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
    lastReplyAt: row.last_reply_at != null ? row.last_reply_at * 1000 : null,
    createdAt: row.created_at * 1000,
    updatedAt: row.updated_at * 1000,
    syncStatus: (row.sync_status as Thread['syncStatus']) || 'synced',
  };
}

/**
 * Get all threads for a conversation, ordered by created_at descending.
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
