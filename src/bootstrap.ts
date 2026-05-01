import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  getOrCreateDatabaseKey,
  KeychainTokenStorage,
} from './services/secure-storage';
import { initMMKV } from './stores/middleware/persistence';
import { initDatabase } from './database';
import { runMigrations } from './database/migrations';
import { tokenManager } from './services/api/tokenManager';
import { useAppStore } from './stores/useAppStore';
import { initIdentityKeyCache } from './services/crypto/keyGenerationService';

/**
 * App bootstrap sequence — runs once before any screens mount.
 *
 * Order matters:
 * 1. Detect fresh install and wipe stale iOS Keychain data.
 * 2. Retrieve (or generate) the MMKV encryption key from Keychain.
 * 3. Initialize MMKV with that key so Zustand persist middleware works.
 * 4. Retrieve (or generate) the SQLCipher database key from Keychain.
 * 5. Open the encrypted database and run pending migrations.
 * 6. Swap the token manager to Keychain-backed storage.
 * 7. Register 401 callback so token clearance automatically clears auth state.
 */
export async function bootstrap(): Promise<void> {
  await clearKeychainIfFreshInstall();
  const mmkvKey = await getOrCreateMMKVKey();
  initMMKV(mmkvKey);
  useAppStore.persist.rehydrate();
  const dbKey = await getOrCreateDatabaseKey();
  initDatabase(dbKey);
  runMigrations();
  await initIdentityKeyCache();
  tokenManager.configure(new KeychainTokenStorage());
  // Global 401 handler: when tokens are cleared (e.g. on HTTP 401),
  // automatically clear auth state so the app gate shows the login screen.
  tokenManager.onTokensCleared = () => {
    useAppStore.getState().clearAuth();
  };
}
