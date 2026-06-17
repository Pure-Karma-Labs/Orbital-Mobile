/**
 * Auth orchestration service.
 *
 * Coordinates between the auth/user API layer, token manager, and app store.
 * Components call these functions instead of touching the API or store directly.
 */

import * as auth from './api/auth';
import * as users from './api/users';
import { tokenManager } from './api/tokenManager';
import { ApiError, ConflictError, NetworkError } from './api/errors';
import type { BlockingOrbit } from './api/errors';
import { useAppStore } from '../stores/useAppStore';
import {
  generateInitialKeys,
  uploadInitialPreKeyBundle,
  ensureKeysInitialized,
  clearIdentityKeyCache,
  fullCryptoWipe,
} from './crypto/keyGenerationService';
import { clearGroupKeyCache, clearContentCryptoInflight, persistGroupKey } from './crypto/contentCrypto';
import * as inviteCrypto from './crypto/inviteCrypto';
import { arrayBufferToBase64, toArrayBuffer } from './crypto/utils';
import { clearEciesLockState, loadEciesLockState } from './crypto/downgradeProtection';
import { clearProcessedMediaIds } from './threadService';
import { clearAllThreads } from '../database/repositories/threadRepository';
import { clearAllReplies } from '../database/repositories/replyRepository';
import { clearLinkPreviewCache } from '../hooks/useLinkPreview';
import { clearIdentityInflightState } from './crypto/identityKeyAccess';
import { clearMessageHandlerState } from './websocket/messageHandler';
import { execute } from '../database/queryHelpers';
import { isDatabaseInitialized, closeDatabase } from '../database/connection';
import { getItem, setItem } from '../database/repositories/itemRepository';
import { loadConversations, loadDmConversations, fulfillPendingWraps, hydrateContactsFromOrbits, clearConversationServiceState, selfWrapIfNeeded } from './conversationService';
import { websocketManager } from './websocket';
import { deregisterCurrentDevice } from './notificationService';
import {
  DocumentDirectoryPath,
  CachesDirectoryPath,
  unlink,
  readDir,
  exists,
} from '@dr.pogodin/react-native-fs';
import { clearAll as clearSecureStorage } from './secure-storage';
import { syncBlockedUsers } from './blockedUsersSync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warnCatch(tag: string) {
  return (e: unknown) => {
    if (__DEV__) console.warn(tag, e instanceof Error ? e.message : e);
  };
}

/**
 * Shared post-authentication bootstrap sequence.
 *
 * Called after login, signup, and session restore to hydrate conversations,
 * contacts, pending wraps, and crypto state. Each step is catch-guarded so
 * a single failure never prevents the remaining bootstrap tasks.
 */
async function postAuthBootstrap(): Promise<void> {
  loadEciesLockState();
  await loadConversations().catch(warnCatch('[ConversationSync]'));
  await loadDmConversations().catch(warnCatch('[DmSync]'));
  hydrateContactsFromOrbits().catch(warnCatch('[ContactHydration]'));
  fulfillPendingWraps().catch(warnCatch('[PendingWraps]'));
  ensureKeysInitialized().catch(warnCatch('[KeyMaintenance]'));
  syncBlockedUsers().catch(warnCatch('[BlockedUsersSync]'));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeleteAccountResult =
  | { status: 'success' }
  | { status: 'incorrect_password' }
  | { status: 'blocking_orbits'; blockingOrbits: BlockingOrbit[] }
  | { status: 'error'; message: string };

/**
 * Log in with email + password. On success, stores tokens and populates
 * the auth store slice. Throws on any API error.
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<void> {
  const response = await auth.login({ email, password });
  await tokenManager.setTokens(response.token, undefined);
  useAppStore.getState().setUser({
    userId: response.userId,
    username: response.username,
    displayName: null,
    avatarPath: null,
  });

  // Account-switch guard: if a different user logs in, wipe all crypto state
  if (isDatabaseInitialized()) {
    const lastUserId = getItem('lastUserId');
    if (lastUserId && lastUserId !== response.userId) {
      await fullCryptoWipe();
      useAppStore.getState().setContacts([]);
    }
    setItem('lastUserId', response.userId);
  }

  await postAuthBootstrap();
}

/**
 * Sign up with username, password, email, and invite code.
 * On success, stores tokens and populates the auth store slice.
 * Throws on any API error.
 */
export async function signupUser(
  username: string,
  password: string,
  email: string,
  inviteCode: string,
): Promise<void> {
  const response = await auth.signup({ username, password, email, inviteCode, publicKey: { type: 'placeholder' } });
  await tokenManager.setTokens(response.token, undefined);
  useAppStore.getState().setUser({
    userId: response.userId,
    username: response.username,
    displayName: null,
    avatarPath: null,
  });

  // Account-switch guard: wipe residual crypto if a different user was here before
  if (isDatabaseInitialized()) {
    const lastUserId = getItem('lastUserId');
    if (lastUserId && lastUserId !== response.userId) {
      await fullCryptoWipe();
      useAppStore.getState().setContacts([]);
    }
    setItem('lastUserId', response.userId);
  }

  try {
    await generateInitialKeys();
    await uploadInitialPreKeyBundle();
  } catch (e: unknown) {
    if (__DEV__) console.warn('[KeyGeneration]', e instanceof Error ? e.message : e);
  }

  // v2 invite key delivery: decrypt group key from invite blob if present
  if (response.inviteEncryptedGroupKey && response.groupId) {
    try {
      const cleanCode = inviteCrypto.stripInviteCode(inviteCode);
      const groupKey = inviteCrypto.decryptGroupKeyFromInvite(
        response.inviteEncryptedGroupKey, cleanCode, response.groupId,
      );
      persistGroupKey(response.groupId, arrayBufferToBase64(toArrayBuffer(groupKey)));
      selfWrapIfNeeded(response.groupId).catch(() => {});
    } catch (e) {
      // Async fallback: sendWrapKeyRequests already fired server-side
      if (__DEV__) console.warn('[signup] v2 invite key decrypt failed, relying on async delivery', e);
    }
  }

  await postAuthBootstrap();
}

/**
 * Attempt to restore a session from a stored access token.
 *
 * Returns true if session was successfully restored, false if there was no
 * token or the token was invalid (tokens cleared on invalid).
 * Re-throws NetworkError so the caller can handle retry.
 */
export async function restoreSession(): Promise<boolean> {
  const token = await tokenManager.getAccessToken();
  if (token === null) return false;

  try {
    await auth.verifyToken();
    const profile = await users.getMe();
    useAppStore.getState().setUser({
      userId: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      avatarPath: profile.avatarUrl ?? null,
    });

    // Account-switch guard: if a different user logs in, wipe all crypto state
    if (isDatabaseInitialized()) {
      const lastUserId = getItem('lastUserId');
      if (lastUserId && lastUserId !== profile.id) {
        await fullCryptoWipe();
        useAppStore.getState().setContacts([]);
      }
      setItem('lastUserId', profile.id);
    }

    await postAuthBootstrap();
    return true;
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    // AuthError or any other failure — token is invalid, clear it
    await tokenManager.clearTokens();
    return false;
  }
}

// ---------------------------------------------------------------------------
// localWipe — shared teardown used by both logout and deleteAccount
// ---------------------------------------------------------------------------

/**
 * Local device wipe shared by logout and account deletion.
 *
 * @param preserveIdentity
 *   - `true` (logout): clears sessions/sender-keys but preserves identity keys,
 *     pre-keys, items, and the DB file — the same user can re-login.
 *   - `false` (delete): full crypto wipe, deletes decrypted media, temp chunks,
 *     the DB file, and all secure storage. The device is left pristine.
 *
 * ORDERING (critical for preserveIdentity=false):
 *   1. fullCryptoWipe (while DB is open — clears signal_* tables + Keychain identity key)
 *   2. closeDatabase() — releases the file handle
 *   3. unlink orbital.db + WAL/SHM files
 *   4. clearSecureStorage (removes DATABASE_ENCRYPTION_KEY last)
 *
 * Each step is wrapped in try/catch — best-effort. A mid-wipe failure must not
 * brick next launch by leaving an unopenable DB (key gone but file remains).
 */
export async function localWipe({ preserveIdentity }: { preserveIdentity: boolean }): Promise<void> {
  // --- Phase 1: Clear tokens and store state (best-effort per-step) ---
  // Each step is isolated so a failure in one (e.g., Keychain op) never
  // aborts the remaining cleanup steps or the destructive wipe that follows.
  try { await tokenManager.clearTokens(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearTokens failed');
  }
  try { useAppStore.getState().clearAuth(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearAuth failed');
  }
  try {
    const state = useAppStore.getState();
    state.setConversations([]);
    state.setContacts([]);
    state.setViewingConversation(null);
  } catch {
    if (__DEV__) console.warn('[LocalWipe] store reset failed');
  }
  try { clearIdentityKeyCache(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearIdentityKeyCache failed');
  }
  try { clearGroupKeyCache(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearGroupKeyCache failed');
  }
  try { clearEciesLockState(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearEciesLockState failed');
  }
  try { clearProcessedMediaIds(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearProcessedMediaIds failed');
  }
  try { clearConversationServiceState(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearConversationServiceState failed');
  }
  try { clearContentCryptoInflight(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearContentCryptoInflight failed');
  }
  try { clearIdentityInflightState(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearIdentityInflightState failed');
  }
  try { clearMessageHandlerState(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearMessageHandlerState failed');
  }
  try { clearLinkPreviewCache(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearLinkPreviewCache failed');
  }
  try { clearAllThreads(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearAllThreads failed');
  }
  try { clearAllReplies(); } catch {
    if (__DEV__) console.warn('[LocalWipe] clearAllReplies failed');
  }
  try { useAppStore.getState().resetBlockedUsers(); } catch {
    if (__DEV__) console.warn('[LocalWipe] resetBlockedUsers failed');
  }

  if (preserveIdentity) {
    // --- Logout path: clear per-session Signal state only ---
    if (isDatabaseInitialized()) {
      try {
        execute('DELETE FROM signal_sessions');
        execute('DELETE FROM signal_sender_keys');
      } catch {
        if (__DEV__) console.warn('[LocalWipe] Failed to clear session tables');
      }
    }
  } else {
    // --- Deletion path: full destructive wipe ---

    // 1. Full crypto wipe (while DB is still open)
    try {
      await fullCryptoWipe();
    } catch {
      if (__DEV__) console.warn('[LocalWipe] fullCryptoWipe failed');
    }

    // 2. Delete decrypted media directory
    const mediaDirPath = `${DocumentDirectoryPath}/media`;
    try {
      const mediaExists = await exists(mediaDirPath);
      if (mediaExists) {
        // Recursively delete all files in media dir
        const files = await readDir(mediaDirPath);
        for (const file of files) {
          await unlink(file.path).catch(() => {});
        }
        await unlink(mediaDirPath).catch(() => {});
      }
    } catch {
      if (__DEV__) console.warn('[LocalWipe] Failed to delete media dir');
    }

    // 3. Delete temp upload chunks from CachesDirectory
    try {
      const cacheFiles = await readDir(CachesDirectoryPath);
      for (const file of cacheFiles) {
        if (file.name.includes('-chunk-') && file.name.endsWith('.bin')) {
          await unlink(file.path).catch(() => {});
        }
      }
    } catch {
      if (__DEV__) console.warn('[LocalWipe] Failed to clean temp chunks');
    }

    // 4. Close DB connection then unlink the file
    try {
      closeDatabase();
    } catch {
      if (__DEV__) console.warn('[LocalWipe] closeDatabase failed');
    }

    const dbPath = `${DocumentDirectoryPath}/orbital.db`;
    try {
      await unlink(dbPath);
    } catch {
      if (__DEV__) console.warn('[LocalWipe] Failed to unlink orbital.db');
    }
    try {
      await unlink(`${dbPath}-wal`);
    } catch {
      // WAL may not exist
    }
    try {
      await unlink(`${dbPath}-shm`);
    } catch {
      // SHM may not exist
    }

    // 5. Clear all Keychain entries (DATABASE_ENCRYPTION_KEY, etc.)
    try {
      await clearSecureStorage();
    } catch {
      if (__DEV__) console.warn('[LocalWipe] clearSecureStorage failed');
    }
  }

  // --- Clear MMKV persistence (both paths) ---
  const { getMMKVInstance } = require('../stores/middleware/persistence');
  try {
    getMMKVInstance().clearAll();
  } catch {
    // MMKV may not be initialized in tests or if bootstrap hasn't run
  }
}

/**
 * Log out the current user.
 *
 * Disconnects WebSocket, deregisters push token (while JWT is still valid),
 * then performs a local wipe preserving identity keys for re-login.
 */
export async function logout(): Promise<void> {
  // Disconnect WebSocket BEFORE clearing tokens to prevent reconnect attempts
  // with stale JWT during the cleanup window.
  websocketManager.disconnect();
  // Deregister device from push notifications while we still have a valid JWT.
  // Best-effort — errors are swallowed so they never block logout.
  await deregisterCurrentDevice();
  await localWipe({ preserveIdentity: true });
}

/**
 * Permanently delete the user's account. Remote-first, then local wipe.
 *
 * Flow:
 * 1. Disconnect WebSocket (prevent stale reconnects during deletion)
 * 2. Call DELETE /api/users/:userId with password confirmation
 * 3. On success: full local wipe (preserveIdentity: false)
 * 4. On failure: nothing is wiped; error surfaced to caller
 *
 * Returns a discriminated result so the UI can react appropriately:
 * - 'success': account deleted, local state wiped, app navigates to login
 * - 'incorrect_password': 403, inline error in modal
 * - 'blocking_orbits': 409, user must transfer/dissolve orbits first
 * - 'error': network or unexpected error
 */
export async function deleteAccount(password: string): Promise<DeleteAccountResult> {
  const userId = useAppStore.getState().userId;
  if (!userId) {
    return { status: 'error', message: 'Not authenticated' };
  }

  // Disconnect WS before the API call — token will be dead after deletion
  websocketManager.disconnect();

  try {
    await users.deleteAccount(userId, password);
  } catch (e: unknown) {
    // On ANY failure, do NOT wipe. Reconnect WS so user remains logged in.
    websocketManager.connect();

    if (e instanceof ConflictError) {
      return { status: 'blocking_orbits', blockingOrbits: e.blockingOrbits };
    }
    if (e instanceof ApiError) {
      if (e.statusCode === 403) {
        return { status: 'incorrect_password' };
      }
      if (e instanceof NetworkError) {
        return { status: 'error', message: 'Network error — please check your connection' };
      }
      return { status: 'error', message: e.message };
    }
    return { status: 'error', message: e instanceof Error ? e.message : 'Unknown error' };
  }

  // Success — the account IS gone server-side. Perform full local wipe best-effort.
  // Even if the wipe partially fails, we must return success and ensure the app
  // navigates to login (clearAuth/clearTokens must run).
  try {
    await localWipe({ preserveIdentity: false });
  } catch {
    // Best-effort: ensure clearAuth/clearTokens ran so auth gate navigates to login
    try { await tokenManager.clearTokens(); } catch { /* swallow */ }
    try { useAppStore.getState().clearAuth(); } catch { /* swallow */ }
  }
  return { status: 'success' };
}

/**
 * Request a password reset code be sent to the given email.
 * The backend always returns a generic success to prevent email enumeration.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await auth.forgotPassword(email);
}

/**
 * Reset the user's password using a code received via email.
 * On success the user must log in again with the new password.
 */
export async function resetPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  await auth.resetPasswordWithCode(email, code, newPassword);
}
