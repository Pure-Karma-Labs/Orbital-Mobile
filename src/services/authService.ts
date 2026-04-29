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
  await tokenManager.setTokens(response.token, response.refreshToken);
  useAppStore.getState().setUser({
    userId: response.userId,
    username: response.username,
    displayName: response.displayName,
    // API returns avatarUrl, store uses avatarPath
    avatarPath: response.avatarUrl ?? null,
  });
  ensureKeysInitialized().catch((e: unknown) =>
    console.warn('[KeyMaintenance]', e instanceof Error ? e.message : 'unknown error'),
  );
  loadConversations().catch((e: unknown) =>
    console.warn('[ConversationSync]', e instanceof Error ? e.message : 'unknown error'),
  );
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
  await tokenManager.setTokens(response.token, response.refreshToken);
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
    console.warn('[KeyGeneration] Initial key generation failed — will retry on next launch',
      e instanceof Error ? e.message : 'unknown error');
  }
  loadConversations().catch((e: unknown) =>
    console.warn('[ConversationSync]', e instanceof Error ? e.message : 'unknown error'),
  );
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
    ensureKeysInitialized().catch((e: unknown) =>
      console.warn('[KeyMaintenance]', e instanceof Error ? e.message : 'unknown error'),
    );
    loadConversations().catch((e: unknown) =>
      console.warn('[ConversationSync]', e instanceof Error ? e.message : 'unknown error'),
    );
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
  // Clear auth state — clearAuth() triggers onTokensCleared via tokenManager,
  // but calling it explicitly here ensures it runs even if that callback isn't
  // registered yet (e.g. in tests).
  useAppStore.getState().clearAuth();
  // Reset domain slices to initial state
  const state = useAppStore.getState();
  state.setConversations([]);
  state.setContacts([]);
  // Clear cached identity key — prevents previous user's key from persisting in memory
  clearIdentityKeyCache();
  // Clear MMKV persistence — prevents previous user's data from surviving
  const { getMMKVInstance } = require('../stores/middleware/persistence');
  try {
    getMMKVInstance().clearAll();
  } catch {
    // MMKV may not be initialized in tests or if bootstrap hasn't run
  }
}
