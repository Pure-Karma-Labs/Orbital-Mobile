/**
 * Reply persistence repository — CRUD operations on orbital_replies.
 *
 * Stores decrypted reply data (body, author_username, depth) for local
 * hydration and offline viewing. Encrypted blob columns are left NULL;
 * decryption happens in the service layer before data reaches here.
 *
 * Timestamps: epoch MILLISECONDS in both the DB and the store since #821.
 * Rows written before that hold epoch seconds; mapRowToReply reads either
 * (see ../timestampUnits). No migration: the tolerant read covers old rows,
 * and any row the server still returns is rewritten in ms on the next load.
 */

import { queryMany, execute } from '../queryHelpers';
import { getDatabase } from '../connection';
import { isDatabaseInitialized } from '../connection';
import { toMillis } from '../timestampUnits';
import type { Reply } from '../../types/store';

// ============================================================
// Write operations
// ============================================================

/**
 * Insert or replace a reply row. Writes plaintext columns only;
 * encrypted blob columns are left NULL.
 */
export function saveReply(reply: Reply): void {
  if (!isDatabaseInitialized()) return;

  const sql = `INSERT OR REPLACE INTO orbital_replies
    (id, thread_id, author_id, body, author_username,
     parent_reply_id, depth, created_at, updated_at, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    reply.id,
    reply.threadId,
    reply.authorId,
    reply.body ?? null,
    reply.authorUsername,
    reply.parentReplyId ?? null,
    reply.depth,
    Math.floor(reply.createdAt),
    Math.floor(reply.updatedAt),
    reply.syncStatus,
  ];

  execute(sql, params);
}

/**
 * Batch-insert replies in a single transaction.
 * Uses BEGIN IMMEDIATE / COMMIT with ROLLBACK on error.
 */
export function saveReplyBatch(threadId: string, replies: Reply[]): void {
  if (!isDatabaseInitialized() || replies.length === 0) return;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const reply of replies) {
      // Ensure all replies in the batch belong to the declared thread
      const r = reply.threadId === threadId ? reply : { ...reply, threadId };
      saveReply(r);
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

interface ReplyRow {
  id: string;
  thread_id: string;
  author_id: string;
  body: string | null;
  author_username: string | null;
  parent_reply_id: string | null;
  depth: number;
  /** Epoch ms since #821; legacy rows hold seconds — read via toMillis. */
  created_at: number;
  /** Epoch ms since #821; legacy rows hold seconds — read via toMillis. */
  updated_at: number;
  sync_status: string;
}

function mapRowToReply(row: ReplyRow): Reply {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    authorUsername: row.author_username ?? '',
    body: row.body,
    parentReplyId: row.parent_reply_id,
    depth: row.depth,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    syncStatus: (row.sync_status as Reply['syncStatus']) || 'synced',
  };
}

/**
 * Get all replies for a thread.
 *
 * Rows may mix legacy epoch-seconds with ms (#821), so this SQL order is only
 * a hint — callers re-sort by the mapped ms value (replyTree). Do NOT add
 * LIMIT/OFFSET or any WHERE on created_at here without normalising the unit
 * first.
 *
 * Returns empty array if database is not initialized.
 */
export function getRepliesForThread(threadId: string): Reply[] {
  if (!isDatabaseInitialized()) return [];

  const rows = queryMany<ReplyRow>(
    'SELECT * FROM orbital_replies WHERE thread_id = ? ORDER BY created_at ASC',
    [threadId],
  );

  return rows.map(mapRowToReply);
}

// ============================================================
// Delete operations
// ============================================================

export function deleteReply(id: string): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_replies WHERE id = ?', [id]);
}

export function deleteRepliesForThread(threadId: string): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_replies WHERE thread_id = ?', [threadId]);
}

/**
 * Delete all replies whose parent thread belongs to the given conversation.
 * Uses a subquery since replies reference thread_id, not conversation_id directly.
 * Used for group dissolution cleanup.
 */
export function deleteRepliesForConversation(conversationId: string): void {
  if (!isDatabaseInitialized()) return;
  execute(
    'DELETE FROM orbital_replies WHERE thread_id IN (SELECT id FROM orbital_threads WHERE conversation_id = ?)',
    [conversationId],
  );
}

export function clearAllReplies(): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM orbital_replies');
}
