/**
 * Verification service — bridges SQLCipher identity key storage and
 * Zustand contacts store for identity verification status tracking.
 */

import { getAllIdentityKeys, updateIdentityKeyVerified } from '../database/repositories/signalIdentityKeyRepository';
import { VerifiedStatus } from '../types/database';
import { refreshAndCompareIdentityKey } from './crypto/identityKeyAccess';
import { useAppStore } from '../stores/useAppStore';

/**
 * Sync verified status from all stored identity keys into the contacts store.
 * Called at bootstrap after initIdentityKeyCache().
 *
 * No-ops gracefully for contacts that don't exist yet in the store
 * (bootstrap timing: contacts may not be populated yet).
 */
export function syncVerifiedStatusToStore(): void {
  const allKeys = getAllIdentityKeys();
  const store = useAppStore.getState();

  for (const key of allKeys) {
    if (key.address === 'local') continue;
    const contact = store.contacts[key.address];
    if (contact) {
      store.setContactVerifiedStatus(key.address, key.verified);
    }
  }
}

/**
 * Mark a contact as Verified in both SQLCipher and the contacts store.
 * Warns if the identity key row doesn't exist (0 rows affected).
 */
export function markContactVerified(userId: string): void {
  const rowsAffected = updateIdentityKeyVerified(userId, VerifiedStatus.Verified);
  if (rowsAffected === 0) {
    if (__DEV__) {
      console.warn('[verificationService] markContactVerified: no identity key row for', userId);
    }
    return;
  }
  useAppStore.getState().setContactVerifiedStatus(userId, VerifiedStatus.Verified);
}

/**
 * Refresh a user's identity key from the server and update the store if changed.
 * Returns true if the identity key has changed.
 */
export async function checkIdentityAndNotify(
  userId: string,
  currentUserId: string,
): Promise<boolean> {
  const result = await refreshAndCompareIdentityKey(userId, currentUserId);
  if (result.identityChanged) {
    useAppStore.getState().setContactVerifiedStatus(userId, VerifiedStatus.Unverified);
  }
  return result.identityChanged;
}
