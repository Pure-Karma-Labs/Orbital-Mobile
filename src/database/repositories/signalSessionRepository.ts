import type { SignalSessionRow } from '../../types/database';
import { queryOne, queryMany, execute } from '../queryHelpers';

export function getSession(
  ourServiceId: string,
  serviceId: string,
  deviceId: number,
): SignalSessionRow | null {
  return queryOne<SignalSessionRow>(
    'SELECT * FROM signal_sessions WHERE our_service_id = ? AND service_id = ? AND device_id = ?',
    [ourServiceId, serviceId, deviceId],
  );
}

export function saveSession(row: SignalSessionRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_sessions
       (our_service_id, service_id, device_id, record, version)
     VALUES (?, ?, ?, ?, ?)`,
    [row.our_service_id, row.service_id, row.device_id, row.record, row.version],
  );
}

export function removeSession(
  ourServiceId: string,
  serviceId: string,
  deviceId: number,
): void {
  execute(
    'DELETE FROM signal_sessions WHERE our_service_id = ? AND service_id = ? AND device_id = ?',
    [ourServiceId, serviceId, deviceId],
  );
}

export function getSessionsForService(serviceId: string): SignalSessionRow[] {
  return queryMany<SignalSessionRow>(
    'SELECT * FROM signal_sessions WHERE service_id = ?',
    [serviceId],
  );
}

export function removeAllSessionsForService(serviceId: string): void {
  execute('DELETE FROM signal_sessions WHERE service_id = ?', [serviceId]);
}
