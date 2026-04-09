import type { OrbitalKyberPreKeyStore } from 'orbital-signal';
import {
  getKyberPreKey,
  saveKyberPreKey,
  markKyberPreKeyUsed,
} from '../../database/repositories/signalKyberPreKeyRepository';
import { toArrayBuffer } from './utils';

export class KyberPreKeyStoreImpl implements OrbitalKyberPreKeyStore {
  loadKyberPreKey(id: number): ArrayBuffer | undefined {
    const row = getKyberPreKey(id);
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.key_data);
  }

  storeKyberPreKey(id: number, record: ArrayBuffer): void {
    saveKyberPreKey({
      id,
      key_data: new Uint8Array(record),
      is_last_resort: 0,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  markKyberPreKeyUsed(id: number): void {
    markKyberPreKeyUsed(id);
  }
}
