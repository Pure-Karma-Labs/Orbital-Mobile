import type { OrbitalSignedPreKeyStore } from 'orbital-signal';
import {
  getSignedPreKey,
  saveSignedPreKey,
} from '../../database/repositories/signalSignedPreKeyRepository';

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export class SignedPreKeyStoreImpl implements OrbitalSignedPreKeyStore {
  loadSignedPreKey(id: number): ArrayBuffer | undefined {
    const row = getSignedPreKey(id);
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.key_data);
  }

  storeSignedPreKey(id: number, record: ArrayBuffer): void {
    saveSignedPreKey({
      id,
      key_data: new Uint8Array(record),
      created_at: Math.floor(Date.now() / 1000),
      confirmed: 0,
    });
  }
}
