import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  getOrCreateDatabaseKey,
  KeychainTokenStorage,
} from './services/secure-storage';
import { initMMKV, isMMKVInitialized } from './stores/middleware/persistence';
import { initDatabase, isDatabaseInitialized } from './database';
import { runMigrations } from './database/migrations';
import { normalizeLegacyMediaPaths } from './database/migrations/normalizeMediaPaths';
import { tokenManager } from './services/api/tokenManager';
import { useAppStore } from './stores/useAppStore';
import { initIdentityKeyCache } from './services/crypto/keyGenerationService';
import { installGroupKeyFailureReporter } from './services/groupKeyTelemetry';
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
 * Cached in-flight (or completed) bootstrap. `bootstrap()` is called from
 * App.tsx's cold-start effect, which runs again whenever the React tree is
 * remounted — on Android that happens on every activity re-create (rotation,
 * dark-mode toggle, process-level config change), and a second unguarded run
 * threw `MMKV already initialized` (#914).
 */
let bootstrapPromise: Promise<void> | null = null;

/** Set once the one-time listener registrations at the tail have been made. */
let sideEffectsInstalled = false;

/**
 * App bootstrap sequence — idempotent: the first call runs it, every later
 * call awaits the same result.
 *
 * Deliberately thin so anything that must happen before the first `await`
 * (e.g. installing an error reporter) has an obvious home here. On failure the
 * cache is cleared and the error rethrown, so a caller can retry.
 */
export function bootstrap(): Promise<void> {
  // BEFORE the first await, and a static import rather than the lazy
  // `import().then()` convention used for the registration tail: a group-key
  // failure can surface from any awaited step below (a lazy media drain, a
  // rehydrated screen), and a reporter installed after an await would miss it.
  // Safe statically — Sentry is initialized in index.js long before bootstrap,
  // and the registry this writes to (crypto/groupKeyErrors) has no imports at
  // all. Idempotent: it only assigns the registry slot.
  installGroupKeyFailureReporter();
  if (bootstrapPromise === null) {
    bootstrapPromise = runBootstrap().catch((e: unknown) => {
      // A failed bootstrap must be retryable: drop the cache so the next call
      // re-runs the sequence (the step guards below make the retry skip
      // whatever already succeeded).
      bootstrapPromise = null;
      throw e;
    });
  }
  return bootstrapPromise;
}

/**
 * Clear the bootstrap cache so a subsequent bootstrap() re-runs the sequence.
 * Test-only — never call this in production code.
 */
export function resetBootstrapForTesting(): void {
  bootstrapPromise = null;
  sideEffectsInstalled = false;
}

/**
 * The actual bootstrap sequence.
 *
 * Order matters:
 * 1. Detect fresh install and wipe stale iOS Keychain data.
 * 2. Retrieve (or generate) the MMKV encryption key from Keychain.
 * 3. Initialize MMKV with that key so Zustand persist middleware works.
 * 4. Retrieve (or generate) the SQLCipher database key from Keychain.
 * 5. Open the encrypted database and run pending migrations.
 * 6. Swap the token manager to Keychain-backed storage.
 * 7. Register 401 callback so token clearance automatically clears auth state.
 *
 * Steps 2–3 and 4 sit behind "already initialized?" guards placed ABOVE the
 * Keychain fetches, so a retry after a mid-sequence failure neither re-reads a
 * key nor re-initializes a live handle.
 */
async function runBootstrap(): Promise<void> {
  await clearKeychainIfFreshInstall();
  if (!isMMKVInitialized()) {
    const mmkvKey = await getOrCreateMMKVKey();
    initMMKV(mmkvKey);
  }
  // Unconditional: rehydrate is idempotent and must have completed before
  // App.tsx reads persisted state, on a retry as much as on the first run.
  // Must complete ahead of App.tsx's auth effect: notificationService's
  // registerIfEnabled() reads the persisted pushOptOut intent, and an
  // un-hydrated read defaults to false and re-registers (#683). Awaited so the
  // ordering is structural, not a side effect of MMKV's getItem happening to
  // be synchronous today.
  await useAppStore.persist.rehydrate();
  if (!isDatabaseInitialized()) {
    const dbKey = await getOrCreateDatabaseKey();
    initDatabase(dbKey);
  }
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
  // Outside the guard below: configure() replaces the storage adapter
  // wholesale, so re-running it on a retry is a no-op swap for an equivalent
  // instance — unlike the listener registrations, which would stack.
  tokenManager.configure(new KeychainTokenStorage());
  // Everything past this point registers a listener or kicks off a one-shot
  // drain, so it must happen exactly once per process however often bootstrap
  // is called (#914). The flag is set up front: there is no `await` inside the
  // block, so no second caller can interleave into it.
  if (!sideEffectsInstalled) {
    sideEffectsInstalled = true;
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
    // Register foreground-drain listener + schedule initial drain for archive confirms.
    // Lazy import avoids pulling mediaArchiveConfirmService into the bootstrap import chain.
    import('./services/mediaArchiveConfirmService').then(({ registerForegroundConfirmDrain, scheduleArchiveConfirmDrain }) => {
      registerForegroundConfirmDrain();
      scheduleArchiveConfirmDrain();
    });
    // Register the foreground notification-settings sync (#678). Deliberately no
    // initial schedule here — login and key recovery already sync, and the
    // scheduled callback early-returns while unauthenticated anyway.
    // The lazy dynamic import is for startup import cost, matching the four
    // registrations above; it is not import-graph protection (the pre-bootstrap
    // chain is index.js → backgroundPush.ts → notificationConstants, which never
    // reaches this module, and MMKV is already initialized).
    import('./services/notificationSettingsSync').then(({ registerForegroundNotificationSettingsSync }) =>
      registerForegroundNotificationSettingsSync(),
    );
  }
}
