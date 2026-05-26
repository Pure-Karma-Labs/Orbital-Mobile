/**
 * Auth orchestration service.
 *
 * Coordinates between the auth/user API layer, token manager, and app store.
 * Components call these functions instead of touching the API or store directly.
 */

import * as auth from './api/auth';
import { forgotPassword as apiForgotPassword, resetPasswordWithCode as apiResetPasswordWithCode } from './api/auth';
import * as users from './api/users';
import { tokenManager } from './api/tokenManager';
import { NetworkError } from './api/errors';
import { useAppStore } from '../stores/useAppStore';
import {
  generateInitialKeys,
  uploadInitialPreKeyBundle,
  ensureKeysInitialized,
  clearIdentityKeyCache,
  fullCryptoWipe,
} from './crypto/keyGenerationService';
import { clearGroupKeyCache } from './crypto/contentCrypto';
import { clearEciesLockState, loadEciesLockState } from './crypto/downgradeProtection';
import { clearProcessedMediaIds } from './threadService';
import { execute } from '../database/queryHelpers';
import { isDatabaseInitialized } from '../database/connection';
import { getItem, setItem } from '../database/repositories/itemRepository';
import { loadConversations, loadDmConversations, fulfillPendingWraps } from './conversationService';
import { websocketManager } from './websocket';
import { deregisterCurrentDevice } from './notificationService';

/**
 * Log in with username + password. On success, stores tokens and populates
 * the auth store slice. Throws on any API error.
 */
export async function loginUser(
  username: string,
  password: string,
): Promise<void> {
  const response = await auth.login({ username, password });
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
    }
    setItem('lastUserId', response.userId);
  }

  loadEciesLockState();
  await loadConversations().catch((e: unknown) => {
    if (__DEV__) console.warn('[ConversationSync]', e instanceof Error ? e.message : e);
  });
  await loadDmConversations().catch((e: unknown) => {
    if (__DEV__) console.warn('[DmSync]', e instanceof Error ? e.message : e);
  });
  fulfillPendingWraps().catch((e: unknown) => {
    if (__DEV__) console.warn('[PendingWraps]', e instanceof Error ? e.message : e);
  });
  ensureKeysInitialized().catch((e: unknown) => {
    if (__DEV__) console.warn('[KeyMaintenance]', e instanceof Error ? e.message : e);
  });
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
    }
    setItem('lastUserId', response.userId);
  }

  try {
    await generateInitialKeys();
    await uploadInitialPreKeyBundle();
  } catch (e: unknown) {
    if (__DEV__) console.warn('[KeyGeneration]', e instanceof Error ? e.message : e);
  }
  loadEciesLockState();
  await loadConversations().catch((e: unknown) => {
    if (__DEV__) console.warn('[ConversationSync]', e instanceof Error ? e.message : e);
  });
  await loadDmConversations().catch((e: unknown) => {
    if (__DEV__) console.warn('[DmSync]', e instanceof Error ? e.message : e);
  });
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
      }
      setItem('lastUserId', profile.id);
    }

    loadEciesLockState();
    await loadConversations().catch((e: unknown) => {
      if (__DEV__) console.warn('[ConversationSync]', e instanceof Error ? e.message : e);
    });
    await loadDmConversations().catch((e: unknown) => {
      if (__DEV__) console.warn('[DmSync]', e instanceof Error ? e.message : e);
    });
    fulfillPendingWraps().catch((e: unknown) => {
      if (__DEV__) console.warn('[PendingWraps]', e instanceof Error ? e.message : e);
    });
    ensureKeysInitialized().catch((e: unknown) => {
      if (__DEV__) console.warn('[KeyMaintenance]', e instanceof Error ? e.message : e);
    });
    return true;
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    // AuthError or any other failure — token is invalid, clear it
    await tokenManager.clearTokens();
    return false;
  }
}

/**
 * Log out the current user.
 *
 * Clears tokens, resets ALL store slices to prevent data leaking to the next
 * user, and wipes MMKV persistence.
 */
export async function logout(): Promise<void> {
  // Disconnect WebSocket BEFORE clearing tokens to prevent reconnect attempts
  // with stale JWT during the cleanup window.
  websocketManager.disconnect();
  // Deregister device from push notifications while we still have a valid JWT.
  // Best-effort — errors are swallowed so they never block logout.
  await deregisterCurrentDevice();
  await tokenManager.clearTokens();
  useAppStore.getState().clearAuth();
  const state = useAppStore.getState();
  state.setConversations([]);
  state.setContacts([]);
  clearIdentityKeyCache();
  clearGroupKeyCache();
  clearEciesLockState();
  clearProcessedMediaIds();

  // Clear per-session Signal Protocol state only.
  // Identity keys, pre-keys, and items are PRESERVED so the same user can
  // log back in without losing the ability to decrypt ECIES-wrapped group keys.
  if (isDatabaseInitialized()) {
    try {
      execute('DELETE FROM signal_sessions');
      execute('DELETE FROM signal_sender_keys');
    } catch {
      if (__DEV__) console.warn('[Logout] Failed to clear session tables');
    }
  }

  // Clear MMKV persistence
  const { getMMKVInstance } = require('../stores/middleware/persistence');
  try {
    getMMKVInstance().clearAll();
  } catch {
    // MMKV may not be initialized in tests or if bootstrap hasn't run
  }
}

/**
 * Request a password reset code be sent to the given email.
 * The backend always returns a generic success to prevent email enumeration.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiForgotPassword(email);
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
  await apiResetPasswordWithCode(email, code, newPassword);
}
