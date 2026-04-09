import type {
  OrbitalSessionStore,
  ProtocolAddressData,
} from 'orbital-signal';
import {
  getSession,
  saveSession,
} from '../../database/repositories/signalSessionRepository';

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

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
