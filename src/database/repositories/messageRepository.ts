import type { MessageRow } from '../../types/database';
import { getDatabase } from '../connection';
import { queryOne, queryMany, execute } from '../queryHelpers';

export function getMessage(id: string): MessageRow | null {
  return queryOne<MessageRow>('SELECT * FROM messages WHERE id = ?', [id]);
}

export function saveMessage(row: MessageRow): void {
  execute(
    `INSERT OR REPLACE INTO messages
       (id, conversation_id, sender_id, type, body_encrypted, body_iv,
        server_timestamp, received_at, read, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.conversation_id,
      row.sender_id,
      row.type,
      row.body_encrypted ?? null,
      row.body_iv ?? null,
      row.server_timestamp,
      row.received_at,
      row.read,
      row.expires_at ?? null,
    ],
  );
}

/**
 * Batch insert messages inside a single transaction for efficiency.
 * Uses individual saveMessage() calls so the SQL remains in one place.
 */
export function saveMessages(rows: MessageRow[]): void {
  const db = getDatabase();
  db.executeSync('BEGIN TRANSACTION');
  try {
    for (const row of rows) {
      saveMessage(row);
    }
    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }
}

/**
 * Cursor-based pagination: returns up to `limit` messages for a conversation
 * with server_timestamp strictly less than `beforeTimestamp` (or all if omitted),
 * ordered newest-first.
 */
export function getMessagesForConversation(
  conversationId: string,
  limit: number,
  beforeTimestamp?: number,
): MessageRow[] {
  if (beforeTimestamp !== undefined) {
    return queryMany<MessageRow>(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND server_timestamp < ?
       ORDER BY server_timestamp DESC
       LIMIT ?`,
      [conversationId, beforeTimestamp, limit],
    );
  }
  return queryMany<MessageRow>(
    `SELECT * FROM messages
     WHERE conversation_id = ?
     ORDER BY server_timestamp DESC
     LIMIT ?`,
    [conversationId, limit],
  );
}

export function markAsRead(id: string): void {
  execute('UPDATE messages SET read = 1 WHERE id = ?', [id]);
}

/**
 * Delete messages whose expires_at timestamp is in the past.
 * Returns the number of rows deleted.
 */
export function deleteExpiredMessages(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = execute(
    'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?',
    [now],
  );
  return result.rowsAffected;
}
