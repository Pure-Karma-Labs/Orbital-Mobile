import { getItem } from '../../database/repositories/itemRepository';
import {
  getIdentityKey,
  saveIdentityKey,
} from '../../database/repositories/signalIdentityKeyRepository';
import { VerifiedStatus } from '../../types/database';
import { getCachedIdentityPrivateKeyHex } from './keyGenerationService';
import { fetchRemoteIdentityKeyBundle } from '../api/keys';
import { hexToUint8Array, toArrayBuffer, base64ToArrayBuffer, bytesEqual } from './utils';

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

/**
 * Normalize a decoded identity key to 33 bytes (0x05 prefix for Curve25519).
 */
export function normalizeIdentityKey(decoded: Uint8Array): Uint8Array {
  if (decoded.length === 33) {
    return decoded;
  } else if (decoded.length === 32) {
    const prefixed = new Uint8Array(33);
    prefixed[0] = 0x05;
    prefixed.set(decoded, 1);
    return prefixed;
  }
  throw new Error('Invalid identity key length');
}

const identityInflight = new Map<string, Promise<ArrayBuffer>>();

/**
 * Cache-first identity key resolution — returns the stored key without
 * checking the server.  Suitable for READ paths (unwrap, contact
 * hydration) where a stale key is harmless.
 *
 * **Must NOT be used to select a wrap TARGET key.**  After an identity
 * reset the cached key is the user's destroyed old key; wrapping to it
 * produces unrecoverable ciphertext.  Use {@link refreshAndCompareIdentityKey}
 * for any wrap-for-other-user path.
 */
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
      const keyBytes = normalizeIdentityKey(decoded);

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

// ---------------------------------------------------------------------------
// Identity key refresh (always-fetch, change detection)
// ---------------------------------------------------------------------------

export interface IdentityKeyRefreshResult {
  publicKey: ArrayBuffer;
  identityChanged: boolean;
}

/**
 * Separate inflight map for refresh operations.
 * Must NOT share with identityInflight — the cache-first resolve path
 * and the always-fetch refresh path have different semantics.
 */
const refreshInflight = new Map<string, Promise<IdentityKeyRefreshResult>>();

/**
 * Always fetch the remote identity key and compare against the stored key.
 * If the key has changed, saves with Unverified status.
 * Returns whether the identity has changed.
 */
export async function refreshAndCompareIdentityKey(
  userId: string,
  currentUserId: string,
): Promise<IdentityKeyRefreshResult> {
  if (userId === currentUserId) {
    return { publicKey: getIdentityKeyPair().publicKey, identityChanged: false };
  }

  const existing = refreshInflight.get(userId);
  if (existing) return existing;

  const promise = (async (): Promise<IdentityKeyRefreshResult> => {
    try {
      const bundle = await fetchRemoteIdentityKeyBundle(userId);
      const decoded = new Uint8Array(base64ToArrayBuffer(bundle.identityKey));
      const keyBytes = normalizeIdentityKey(decoded);

      const stored = getIdentityKey(userId);
      if (stored) {
        const storedKey = new Uint8Array(stored.identity_key);
        if (bytesEqual(storedKey, keyBytes)) {
          // Key unchanged
          return { publicKey: toArrayBuffer(keyBytes), identityChanged: false };
        }
        // Key changed — save with Unverified status
        saveIdentityKey({
          address: userId,
          identity_key: keyBytes,
          verified: VerifiedStatus.Unverified,
          first_use: Math.floor(Date.now() / 1000),
          nonblocking_approval: 0,
        });
        return { publicKey: toArrayBuffer(keyBytes), identityChanged: true };
      }

      // No prior key — first time seeing this user, save as Default
      saveIdentityKey({
        address: userId,
        identity_key: keyBytes,
        verified: VerifiedStatus.Default,
        first_use: Math.floor(Date.now() / 1000),
        nonblocking_approval: 0,
      });
      return { publicKey: toArrayBuffer(keyBytes), identityChanged: false };
    } finally {
      refreshInflight.delete(userId);
    }
  })();

  refreshInflight.set(userId, promise);
  return promise;
}

/**
 * Read the verified status of a stored identity key.
 * Returns null if no key is stored for this user.
 */
export function getStoredIdentityVerifiedStatus(userId: string): VerifiedStatus | null {
  const stored = getIdentityKey(userId);
  return stored ? stored.verified : null;
}

export function clearIdentityInflightState(): void {
  identityInflight.clear();
  refreshInflight.clear();
}
