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

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    bytes[i] = byte;
  }
  return bytes;
}

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
