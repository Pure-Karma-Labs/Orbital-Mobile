/**
 * Reply persistence repository — CRUD operations on orbital_replies.
 *
 * Stores decrypted reply data (body, author_username, depth) for local
 * hydration and offline viewing. Encrypted blob columns are left NULL;
 * decryption happens in the service layer before data reaches here.
 *
 * Timestamps: DB stores epoch seconds, store uses epoch milliseconds.
 * Convert on write (/ 1000) and read (* 1000).
 */

import { queryMany, execute } from '../queryHelpers';
import { getDatabase } from '../connection';
import { isDatabaseInitialized } from '../connection';
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
    Math.floor(reply.createdAt / 1000),
    Math.floor(reply.updatedAt / 1000),
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
  created_at: number;
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
    createdAt: row.created_at * 1000,
    updatedAt: row.updated_at * 1000,
    syncStatus: (row.sync_status as Reply['syncStatus']) || 'synced',
  };
}

/**
 * Get all replies for a thread, ordered by created_at ascending.
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
