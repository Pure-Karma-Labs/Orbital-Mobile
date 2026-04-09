import type { OrbitalPreKeyStore } from 'orbital-signal';
import {
  getPreKey,
  savePreKey,
  removePreKey,
} from '../../database/repositories/signalPreKeyRepository';
import { toArrayBuffer } from './utils';

export class PreKeyStoreImpl implements OrbitalPreKeyStore {
  loadPreKey(id: number): ArrayBuffer | undefined {
    const row = getPreKey(id);
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.key_data);
  }

  storePreKey(id: number, record: ArrayBuffer): void {
    savePreKey({
      id,
      key_data: new Uint8Array(record),
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  removePreKey(id: number): void {
    removePreKey(id);
  }
}
