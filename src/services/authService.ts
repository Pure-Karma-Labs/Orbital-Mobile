/**
 * Auth orchestration service.
 *
 * Coordinates between the auth/user API layer, token manager, and app store.
 * Components call these functions instead of touching the API or store directly.
 */

import * as auth from './api/auth';
import * as users from './api/users';
import { tokenManager } from './api/tokenManager';
import { NetworkError } from './api/errors';
import { useAppStore } from '../stores/useAppStore';
import {
  generateInitialKeys,
  uploadInitialPreKeyBundle,
  ensureKeysInitialized,
  clearIdentityKeyCache,
} from './crypto/keyGenerationService';
import { clearGroupKeyCache } from './crypto/contentCrypto';
import { clearAllGroupMasterKeys } from '../database/repositories/conversationRepository';
import { removeSecureItem } from './secure-storage/secureStorage';
import { SecureKeys } from './secure-storage/constants';
import { execute } from '../database/queryHelpers';
import { isDatabaseInitialized } from '../database/connection';
import { loadConversations } from './conversationService';

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
  await loadConversations().catch((e: unknown) => {
    if (__DEV__) console.error('[ConversationSync]', e instanceof Error ? e.message : e);
  });
  ensureKeysInitialized().catch((e: unknown) => {
    if (__DEV__) console.error('[KeyMaintenance]', e instanceof Error ? e.message : e);
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
  const response = await auth.signup({ username, password, email, inviteCode });
  await tokenManager.setTokens(response.token, undefined);
  useAppStore.getState().setUser({
    userId: response.userId,
    username: response.username,
    displayName: null,
    avatarPath: null,
  });
  try {
    await generateInitialKeys();
    await uploadInitialPreKeyBundle();
  } catch (e: unknown) {
    if (__DEV__) console.error('[KeyGeneration]', e instanceof Error ? e.message : e);
  }
  await loadConversations().catch((e: unknown) => {
    if (__DEV__) console.error('[ConversationSync]', e instanceof Error ? e.message : e);
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
    await loadConversations().catch((e: unknown) => {
      if (__DEV__) console.error('[ConversationSync]', e instanceof Error ? e.message : e);
    });
    ensureKeysInitialized().catch((e: unknown) => {
      if (__DEV__) console.error('[KeyMaintenance]', e instanceof Error ? e.message : e);
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
  await tokenManager.clearTokens();
  useAppStore.getState().clearAuth();
  const state = useAppStore.getState();
  state.setConversations([]);
  state.setContacts([]);
  clearIdentityKeyCache();
  clearGroupKeyCache();

  // Clear identity private key from Keychain
  await removeSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE).catch(() => {});

  // Clear SQLCipher: group keys, items table, and all Signal Protocol stores
  if (isDatabaseInitialized()) {
    try {
      clearAllGroupMasterKeys();
      execute('DELETE FROM items');
      execute('DELETE FROM signal_identity_keys');
      execute('DELETE FROM signal_sessions');
      execute('DELETE FROM signal_pre_keys');
      execute('DELETE FROM signal_signed_pre_keys');
      execute('DELETE FROM signal_kyber_pre_keys');
      execute('DELETE FROM signal_sender_keys');
    } catch {
      if (__DEV__) console.error('[Logout] Failed to clear database tables');
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
