import type { ConversationRow } from '../../types/database';
import { queryOne, execute } from '../queryHelpers';

export function getConversation(id: string): ConversationRow | null {
  return queryOne<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?',
    [id],
  );
}

export function removeConversation(id: string): void {
  execute('DELETE FROM conversations WHERE id = ?', [id]);
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

export function clearAllGroupCryptoState(): void {
  execute('UPDATE conversations SET group_master_key = NULL, group_secret_params = NULL, group_public_params = NULL');
}
