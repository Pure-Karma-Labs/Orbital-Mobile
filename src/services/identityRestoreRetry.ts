/**
 * Retry logic for deferred identity restore.
 *
 * Called by the IdentityRestoreBanner (manual tap or app-foreground auto-retry).
 * Re-runs attemptKeychainIdentityRestore() and, on success ('restored' or
 * 'cleared' or 'none'), clears the deferred flag and runs ensureKeysInitialized.
 *
 * On persistent 'deferred', the flag stays set and the banner remains visible.
 *
 * Lives outside crypto/ so Sentry imports are permitted.
 */

import * as Sentry from '@sentry/react-native';
import { attemptKeychainIdentityRestore } from './crypto/identityRestoreService';
import { ensureKeysInitialized } from './crypto/keyGenerationService';
import { useAppStore } from '../stores/useAppStore';
import { ConflictError } from './api/errors';

export async function retryIdentityRestore(): Promise<void> {
  try {
    const result = await attemptKeychainIdentityRestore();

    if (result === 'deferred') {
      // Still can't reach the server — leave the flag set
      return;
    }

    // Restore succeeded (or cleared/none) — clear the deferred flag
    useAppStore.getState().setIdentityRestoreDeferred(false);

    // Sentry telemetry for the restore outcome (outside crypto/ path)
    Sentry.captureMessage(`Identity restore retry: ${result}`, {
      level: result === 'restored' ? 'info' : 'warning',
      tags: { feature: 'key-recovery', outcome: `retry-${result}` },
    });

    // Now run key initialization that was skipped during bootstrap
    await ensureKeysInitialized().catch((e: unknown) => {
      if (e instanceof ConflictError) {
        Sentry.captureMessage('Identity key conflict detected after deferred restore retry (409)', {
          level: 'warning',
          tags: { feature: 'key-recovery', source: 'deferred-retry' },
        });
        useAppStore.getState().setIdentityKeyConflict(true);
        useAppStore.getState().setConflictSource('local');
      } else {
        // Keys are still uninitialized after a successful restore — must be
        // visible in production, not just dev logs.
        if (__DEV__) console.warn('[DeferredRestore:KeyMaintenance]', e instanceof Error ? e.message : e);
        Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
          tags: { feature: 'key-recovery', outcome: 'retry-key-init-failed' },
        });
      }
    });
  } catch (e) {
    // Unexpected error — treat as still deferred
    Sentry.captureException(e, {
      tags: { feature: 'key-recovery', outcome: 'retry-failed' },
    });
  }
}
