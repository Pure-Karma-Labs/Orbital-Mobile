import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  getOrCreateDatabaseKey,
  KeychainTokenStorage,
} from './services/secure-storage';
import { initMMKV } from './stores/middleware/persistence';
import { initDatabase } from './database';
import { runMigrations } from './database/migrations';
import { normalizeLegacyMediaPaths } from './database/migrations/normalizeMediaPaths';
import { tokenManager } from './services/api/tokenManager';
import { useAppStore } from './stores/useAppStore';
import { initIdentityKeyCache } from './services/crypto/keyGenerationService';
import { isRecoveryInitiator } from './services/recoveryState';

/**
 * 401 handler for tokenManager.onTokensCleared.
 *
 * Suppressed while THIS device is running key recovery — an orphaned in-flight
 * request 401ing mid-recovery must not flash the login screen; loginForRecovery
 * restores tokens at step 6 (#543).
 *
 * Precision: race-freedom rests on setRecoveryInitiator(true) being set before
 * any API call and cleared only in `finally` — NOT on listener notification
 * being synchronous (notifyListeners runs after an `await` in clearTokens).
 */
export function handleTokensCleared(): void {
  if (isRecoveryInitiator()) return;
  useAppStore.getState().clearAuth();
}

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
  // Idempotent JS normalization: convert legacy absolute media paths to relative form.
  // Must run after migrations (schema exists) but before any media reads.
  normalizeLegacyMediaPaths();
  await initIdentityKeyCache();
  // Sync identity key verification status into the contacts store.
  // Lazy import avoids pulling verificationService into bootstrap import chain.
  import('./services/verificationService').then(({ syncVerifiedStatusToStore }) =>
    syncVerifiedStatusToStore(),
  );
  tokenManager.configure(new KeychainTokenStorage());
  // Global 401 handler: when tokens are cleared (e.g. on HTTP 401),
  // automatically clear auth state so the app gate shows the login screen.
  // Suppressed during key recovery — see handleTokensCleared for details.
  tokenManager.onTokensCleared(handleTokensCleared);
  // Best-effort cleanup of orphaned chunk temp files from interrupted uploads.
  // Lazy import avoids pulling mediaUploadService into the bootstrap import chain.
  import('./services/mediaUploadService').then(({ cleanupOrphanedChunks }) =>
    cleanupOrphanedChunks(),
  );
  // Best-effort cleanup of orphaned media files (files with no DB row, stale .tmp files).
  // Lazy import avoids pulling mediaDownloadService into the bootstrap import chain.
  import('./services/mediaDownloadService').then(({ cleanupOrphanedMedia }) =>
    cleanupOrphanedMedia(),
  );
  // Register foreground-drain listener + schedule initial drain for pending media.
  // Lazy import avoids pulling mediaPrefetchService into the bootstrap import chain.
  import('./services/mediaPrefetchService').then(({ registerForegroundDrain, schedulePendingMediaDrain }) => {
    registerForegroundDrain();
    schedulePendingMediaDrain();
  });
}
