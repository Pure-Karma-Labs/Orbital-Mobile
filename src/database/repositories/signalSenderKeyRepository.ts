import type { SignalSenderKeyRow } from '../../types/database';
import { queryOne, execute } from '../queryHelpers';

export function getSenderKey(
  ourServiceId: string,
  senderId: string,
  distributionId: string,
): SignalSenderKeyRow | null {
  return queryOne<SignalSenderKeyRow>(
    'SELECT * FROM signal_sender_keys WHERE our_service_id = ? AND sender_id = ? AND distribution_id = ?',
    [ourServiceId, senderId, distributionId],
  );
}

export function saveSenderKey(row: SignalSenderKeyRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_sender_keys
       (our_service_id, sender_id, distribution_id, record, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      row.our_service_id,
      row.sender_id,
      row.distribution_id,
      row.record,
      row.created_at,
    ],
  );
}

export function removeSenderKey(
  ourServiceId: string,
  senderId: string,
  distributionId: string,
): void {
  execute(
    'DELETE FROM signal_sender_keys WHERE our_service_id = ? AND sender_id = ? AND distribution_id = ?',
    [ourServiceId, senderId, distributionId],
  );
}
