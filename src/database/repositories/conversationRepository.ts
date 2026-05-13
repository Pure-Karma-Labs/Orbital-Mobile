import type { ConversationRow } from '../../types/database';
import { queryOne, queryMany, execute } from '../queryHelpers';

export function getConversation(id: string): ConversationRow | null {
  return queryOne<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?',
    [id],
  );
}

export function saveConversation(row: ConversationRow): void {
  execute(
    `INSERT OR REPLACE INTO conversations
       (id, type, name, avatar_path, group_master_key, group_secret_params,
        group_public_params, group_version, member_count, active, mute_until,
        last_message_at, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.type,
      row.name,
      row.avatar_path,
      row.group_master_key ?? null,
      row.group_secret_params ?? null,
      row.group_public_params ?? null,
      row.group_version,
      row.member_count,
      row.active,
      row.mute_until ?? null,
      row.last_message_at ?? null,
      row.unread_count,
      row.created_at,
      row.updated_at,
    ],
  );
}

export function removeConversation(id: string): void {
  execute('DELETE FROM conversations WHERE id = ?', [id]);
}

/**
 * Returns active conversations ordered by most recent message, paginated.
 */
export function getActiveConversations(
  limit: number,
  offset: number,
): ConversationRow[] {
  return queryMany<ConversationRow>(
    `SELECT * FROM conversations
     WHERE active = 1
     ORDER BY last_message_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
}

export function updateUnreadCount(id: string, count: number): void {
  execute('UPDATE conversations SET unread_count = ? WHERE id = ?', [
    count,
    id,
  ]);
}

export function getGroupMasterKey(conversationId: string): Uint8Array | null {
  const row = queryOne<{ group_master_key: Uint8Array | null }>(
    'SELECT group_master_key FROM conversations WHERE id = ?',
    [conversationId],
  );
  return row?.group_master_key ?? null;
}

export function setGroupMasterKey(conversationId: string, key: Uint8Array): void {
  const now = Date.now();
  execute(
    `INSERT INTO conversations (id, type, group_master_key, member_count, active, unread_count, group_version, created_at, updated_at)
     VALUES (?, 'group', ?, 0, 1, 0, 2, ?, ?)
     ON CONFLICT(id) DO UPDATE SET group_master_key = excluded.group_master_key`,
    [conversationId, key, now, now],
  );
}

export function clearGroupMasterKey(conversationId: string): void {
  execute('UPDATE conversations SET group_master_key = NULL WHERE id = ?', [conversationId]);
}

export function clearAllGroupMasterKeys(): void {
  execute('UPDATE conversations SET group_master_key = NULL');
}
