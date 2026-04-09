import type { OrbitalPreKeyStore } from 'orbital-signal';
import {
  getPreKey,
  savePreKey,
  removePreKey,
} from '../../database/repositories/signalPreKeyRepository';
import { toArrayBuffer } from './utils';

/**
 * @deprecated These store implementations were designed for the uniffi callback interface path
 * that is not supported in uniffi 0.31. Protocol operations now use the preloaded store pattern
 * via cryptoService. See Issue #58 for details.
 */
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
