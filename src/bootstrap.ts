import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  KeychainTokenStorage,
} from './services/secure-storage';
import { initMMKV } from './stores/middleware/persistence';
import { tokenManager } from './services/api/tokenManager';
import { useAppStore } from './stores/useAppStore';

/**
 * App bootstrap sequence — runs once before any screens mount.
 *
 * Order matters:
 * 1. Detect fresh install and wipe stale iOS Keychain data.
 * 2. Retrieve (or generate) the MMKV encryption key from Keychain.
 * 3. Initialize MMKV with that key so Zustand persist middleware works.
 * 4. Swap the token manager to Keychain-backed storage.
 * 5. Register 401 callback so token clearance automatically clears auth state.
 */
export async function bootstrap(): Promise<void> {
  await clearKeychainIfFreshInstall();
  const mmkvKey = await getOrCreateMMKVKey();
  initMMKV(mmkvKey);
  tokenManager.configure(new KeychainTokenStorage());
  // Global 401 handler: when tokens are cleared (e.g. on HTTP 401),
  // automatically clear auth state so the app gate shows the login screen.
  tokenManager.onTokensCleared = () => {
    useAppStore.getState().clearAuth();
  };
}
