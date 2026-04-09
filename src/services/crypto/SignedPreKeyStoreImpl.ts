import type { OrbitalSignedPreKeyStore } from 'orbital-signal';
import {
  getSignedPreKey,
  saveSignedPreKey,
} from '../../database/repositories/signalSignedPreKeyRepository';
import { toArrayBuffer } from './utils';

/**
 * @deprecated These store implementations were designed for the uniffi callback interface path
 * that is not supported in uniffi 0.31. Protocol operations now use the preloaded store pattern
 * via cryptoService. See Issue #58 for details.
 */
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
