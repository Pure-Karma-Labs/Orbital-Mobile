import type { OrbitalSignedPreKeyStore } from 'orbital-signal';
import {
  getSignedPreKey,
  saveSignedPreKey,
} from '../../database/repositories/signalSignedPreKeyRepository';
import { toArrayBuffer } from './utils';

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
