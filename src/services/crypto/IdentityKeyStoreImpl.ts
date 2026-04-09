import type {
  OrbitalIdentityKeyStore,
  IdentityKeyPairData,
  ProtocolAddressData,
  Direction,
} from 'orbital-signal';
import { getDatabase } from '../../database/connection';
import { getIdentityKey, saveIdentityKey } from '../../database/repositories/signalIdentityKeyRepository';
import { getItem } from '../../database/repositories/itemRepository';
import { VerifiedStatus } from '../../types/database';
import { toArrayBuffer, bytesEqual, hexToUint8Array } from './utils';

/**
 * @deprecated These store implementations were designed for the uniffi callback interface path
 * that is not supported in uniffi 0.31. Protocol operations now use the preloaded store pattern
 * via cryptoService. See Issue #58 for details.
 */
export class IdentityKeyStoreImpl implements OrbitalIdentityKeyStore {
  private readonly cachedPublic: Uint8Array;
  private readonly cachedPrivate: Uint8Array;
  private readonly cachedRegistrationId: number;

  constructor(_localServiceId: string) {
    const publicHex = getItem('identityKeyPublic');
    const privateHex = getItem('identityKeyPrivate');
    const registrationIdStr = getItem('registrationId');

    if (
      publicHex === null ||
      privateHex === null ||
      registrationIdStr === null
    ) {
      throw new Error(
        'Identity key pair not initialized — generate keys before creating store',
      );
    }

    this.cachedPublic = hexToUint8Array(publicHex);
    this.cachedPrivate = hexToUint8Array(privateHex);
    this.cachedRegistrationId = parseInt(registrationIdStr, 10);
  }

  getIdentityKeyPair(): IdentityKeyPairData {
    return {
      publicKey: toArrayBuffer(this.cachedPublic),
      privateKey: toArrayBuffer(this.cachedPrivate),
    };
  }

  getLocalRegistrationId(): number {
    return this.cachedRegistrationId;
  }

  saveIdentity(address: ProtocolAddressData, identityKey: ArrayBuffer): boolean {
    const db = getDatabase();
    db.executeSync('BEGIN TRANSACTION');
    try {
      const existing = getIdentityKey(address.name);
      const incomingKey = new Uint8Array(identityKey);

      let changed: boolean;

      if (existing === null) {
        saveIdentityKey({
          address: address.name,
          identity_key: incomingKey,
          verified: VerifiedStatus.Default,
          first_use: Math.floor(Date.now() / 1000),
          nonblocking_approval: 0,
        });
        changed = false;
      } else if (bytesEqual(existing.identity_key, incomingKey)) {
        changed = false;
      } else {
        saveIdentityKey({
          address: address.name,
          identity_key: incomingKey,
          verified: VerifiedStatus.Default,
          first_use: existing.first_use,
          nonblocking_approval: existing.nonblocking_approval,
        });
        changed = true;
      }

      db.executeSync('COMMIT');
      return changed;
    } catch (err) {
      db.executeSync('ROLLBACK');
      throw new Error(
        `Failed to save identity for address "${address.name}": ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  isTrustedIdentity(
    address: ProtocolAddressData,
    identityKey: ArrayBuffer,
    _direction: Direction,
  ): boolean {
    const existing = getIdentityKey(address.name);
    if (existing === null) {
      // TOFU — trust on first use
      return true;
    }
    return bytesEqual(existing.identity_key, new Uint8Array(identityKey));
  }

  getIdentity(address: ProtocolAddressData): ArrayBuffer | undefined {
    const row = getIdentityKey(address.name);
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.identity_key);
  }
}
