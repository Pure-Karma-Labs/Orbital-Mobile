import type {
  OrbitalSessionStore,
  ProtocolAddressData,
} from 'orbital-signal';
import {
  getSession,
  saveSession,
} from '../../database/repositories/signalSessionRepository';
import { toArrayBuffer } from './utils';

/**
 * @deprecated These store implementations were designed for the uniffi callback interface path
 * that is not supported in uniffi 0.31. Protocol operations now use the preloaded store pattern
 * via cryptoService. See Issue #58 for details.
 */
export class SessionStoreImpl implements OrbitalSessionStore {
  private readonly localServiceId: string;

  constructor(localServiceId: string) {
    this.localServiceId = localServiceId;
  }

  loadSession(address: ProtocolAddressData): ArrayBuffer | undefined {
    const row = getSession(this.localServiceId, address.name, address.deviceId);
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.record);
  }

  storeSession(address: ProtocolAddressData, record: ArrayBuffer): void {
    saveSession({
      our_service_id: this.localServiceId,
      service_id: address.name,
      device_id: address.deviceId,
      record: new Uint8Array(record),
      version: 2,
    });
  }
}
