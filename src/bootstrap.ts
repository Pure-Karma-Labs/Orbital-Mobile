import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  KeychainTokenStorage,
} from './services/secure-storage';
import { initMMKV } from './stores/middleware/persistence';
import { tokenManager } from './services/api/tokenManager';

/**
 * App bootstrap sequence — runs once before any screens mount.
 *
 * Order matters:
 * 1. Detect fresh install and wipe stale iOS Keychain data.
 * 2. Retrieve (or generate) the MMKV encryption key from Keychain.
 * 3. Initialize MMKV with that key so Zustand persist middleware works.
 * 4. Swap the token manager to Keychain-backed storage.
 */
export async function bootstrap(): Promise<void> {
  await clearKeychainIfFreshInstall();
  const mmkvKey = await getOrCreateMMKVKey();
  initMMKV(mmkvKey);
  tokenManager.configure(new KeychainTokenStorage());
}
