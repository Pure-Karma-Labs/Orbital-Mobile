import type { SignalPreKeyRow } from '../../types/database';
import { queryOne, execute } from '../queryHelpers';

export function getPreKey(id: number): SignalPreKeyRow | null {
  return queryOne<SignalPreKeyRow>(
    'SELECT * FROM signal_pre_keys WHERE id = ?',
    [id],
  );
}

export function savePreKey(row: SignalPreKeyRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_pre_keys
       (id, key_data, created_at)
     VALUES (?, ?, ?)`,
    [row.id, row.key_data, row.created_at],
  );
}

export function removePreKey(id: number): void {
  execute('DELETE FROM signal_pre_keys WHERE id = ?', [id]);
}
