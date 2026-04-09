import type { SignalKyberPreKeyRow } from '../../types/database';
import { queryOne, execute } from '../queryHelpers';

export function getKyberPreKey(id: number): SignalKyberPreKeyRow | null {
  return queryOne<SignalKyberPreKeyRow>(
    'SELECT * FROM signal_kyber_pre_keys WHERE id = ?',
    [id],
  );
}

export function saveKyberPreKey(row: SignalKyberPreKeyRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_kyber_pre_keys
       (id, key_data, is_last_resort, created_at)
     VALUES (?, ?, ?, ?)`,
    [row.id, row.key_data, row.is_last_resort, row.created_at],
  );
}

export function removeKyberPreKey(id: number): void {
  execute('DELETE FROM signal_kyber_pre_keys WHERE id = ?', [id]);
}

/**
 * Mark a Kyber pre-key as used.
 * One-time keys (is_last_resort = 0) are deleted after use.
 * Last-resort keys (is_last_resort = 1) are retained — no-op.
 */
export function markKyberPreKeyUsed(id: number): void {
  const row = getKyberPreKey(id);
  if (row === null) {
    return;
  }
  if (row.is_last_resort === 0) {
    removeKyberPreKey(id);
  }
  // Last-resort keys are never deleted — intentional no-op.
}
