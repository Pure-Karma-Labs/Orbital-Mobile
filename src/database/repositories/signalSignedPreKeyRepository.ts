import type { SignalSignedPreKeyRow } from '../../types/database';
import { queryOne, execute } from '../queryHelpers';

export function getSignedPreKey(id: number): SignalSignedPreKeyRow | null {
  return queryOne<SignalSignedPreKeyRow>(
    'SELECT * FROM signal_signed_pre_keys WHERE id = ?',
    [id],
  );
}

export function saveSignedPreKey(row: SignalSignedPreKeyRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_signed_pre_keys
       (id, key_data, created_at, confirmed)
     VALUES (?, ?, ?, ?)`,
    [row.id, row.key_data, row.created_at, row.confirmed],
  );
}

export function removeSignedPreKey(id: number): void {
  execute('DELETE FROM signal_signed_pre_keys WHERE id = ?', [id]);
}

export function confirmSignedPreKey(id: number): void {
  execute('UPDATE signal_signed_pre_keys SET confirmed = 1 WHERE id = ?', [id]);
}
