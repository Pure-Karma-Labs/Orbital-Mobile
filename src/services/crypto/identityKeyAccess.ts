import { getItem } from '../../database/repositories/itemRepository';
import {
  getIdentityKey,
  saveIdentityKey,
} from '../../database/repositories/signalIdentityKeyRepository';
import { getCachedIdentityPrivateKeyHex } from './keyGenerationService';
import { fetchRemoteIdentityKeyBundle } from '../api/keys';
import { hexToUint8Array, toArrayBuffer, base64ToArrayBuffer } from './utils';

const IDENTITY_KEY_PUBLIC_ITEM = 'identityKeyPublic';

export function getIdentityKeyPair(): {
  privateKey: ArrayBuffer;
  publicKey: ArrayBuffer;
} {
  const privHex = getCachedIdentityPrivateKeyHex();
  const pubHex = getItem(IDENTITY_KEY_PUBLIC_ITEM);
  if (!privHex || !pubHex) {
    throw new Error('Identity key pair not available');
  }
  return {
    privateKey: toArrayBuffer(hexToUint8Array(privHex)),
    publicKey: toArrayBuffer(hexToUint8Array(pubHex)),
  };
}

const identityInflight = new Map<string, Promise<ArrayBuffer>>();

export async function resolveRemoteIdentityKey(
  userId: string,
  currentUserId: string,
): Promise<ArrayBuffer> {
  if (userId === currentUserId) {
    return getIdentityKeyPair().publicKey;
  }

  const stored = getIdentityKey(userId);
  if (stored) {
    return toArrayBuffer(stored.identity_key);
  }

  const existing = identityInflight.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const bundle = await fetchRemoteIdentityKeyBundle(userId);
      const decoded = new Uint8Array(base64ToArrayBuffer(bundle.identityKey));

      let keyBytes: Uint8Array;
      if (decoded.length === 33) {
        keyBytes = decoded;
      } else if (decoded.length === 32) {
        keyBytes = new Uint8Array(33);
        keyBytes[0] = 0x05;
        keyBytes.set(decoded, 1);
      } else {
        throw new Error('Invalid identity key length');
      }

      saveIdentityKey({
        address: userId,
        identity_key: keyBytes,
        verified: 0,
        first_use: Math.floor(Date.now() / 1000),
        nonblocking_approval: 0,
      });

      return toArrayBuffer(keyBytes);
    } finally {
      identityInflight.delete(userId);
    }
  })();

  identityInflight.set(userId, promise);
  return promise;
}
