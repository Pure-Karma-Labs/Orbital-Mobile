/**
 * Key recovery orchestration service.
 *
 * Handles the in-app flow when a device detects an identity key conflict
 * (409 from key upload or identity_key_reset push). Coordinates the multi-step
 * recovery: server reset, local crypto wipe, re-login, and key re-generation.
 *
 * Single-responsibility separation from authService (which is 500+ lines).
 * No import cycle exists (authService -> keyGenerationService is one-directional;
 * this module imports from both but neither imports from here).
 */

import * as Sentry from '@sentry/react-native';
import { useAppStore } from '../stores/useAppStore';
import { loginForRecovery } from './authService';
import { resetIdentityKeys, fetchRemoteIdentityKeyBundle } from './api/keys';
import * as users from './api/users';
import { ApiError, AuthError, NetworkError, NotFoundError } from './api/errors';
import { ConflictError } from './api/errors';
import {
  fullCryptoWipe,
  cancelKeyInitialization,
  ensureKeysInitialized,
  getCachedIdentityPrivateKeyHex,
} from './crypto/keyGenerationService';
import { getItem, removeItem } from '../database/repositories/itemRepository';
import { clearAllArchiveConfirmations } from '../database/repositories/mediaRepository';
import { isDatabaseInitialized } from '../database/connection';
import { clearConversationServiceState } from './conversationService';
import { clearIdentityInflightState } from './crypto/identityKeyAccess';
import { clearMessageHandlerState } from './websocket/messageHandler';
import { loadEciesLockState } from './crypto/downgradeProtection';
import {
  loadConversations,
  loadDmConversations,
  fulfillPendingWraps,
  hydrateContactsFromOrbits,
} from './conversationService';
import { syncBlockedUsers } from './blockedUsersSync';
import { websocketManager } from './websocket';
import { isRecoveryInitiator, setRecoveryInitiator } from './recoveryState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyRecoveryResult =
  | { status: 'success' }
  | { status: 'incorrect_password' }
  | { status: 'rate_limited' }
  | { status: 'needs_email'; message: string }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Transient initiator flag — #539 reads this to suppress self-push
// ---------------------------------------------------------------------------

// Re-exported for backward compatibility — the flag itself now lives in
// recoveryState.ts (dependency-free, to avoid an import cycle with
// notificationService). See recoveryState.ts for details.
export { isRecoveryInitiator };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Like warnCatch (authService.ts), but also captures to Sentry so post-recovery sync failures
 * are visible in production (panel finding: successful recovery + failed sync
 * must not be silent).
 */
function warnAndCapture(tag: string) {
  return (e: unknown) => {
    if (__DEV__) console.warn(tag, e instanceof Error ? e.message : e);
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { feature: 'key-recovery' },
      extra: { step: tag },
    });
  };
}

// ---------------------------------------------------------------------------
// Server-truth probe (Fix 2c — loop-breaker)
// ---------------------------------------------------------------------------

export type ServerProbeOutcome = 'present' | 'absent' | 'unauthorized' | 'unreachable';

/**
 * Probe whether the server still holds an identity key for the given user.
 *
 * Uses `fetchRemoteIdentityKeyBundle` (GET /v1/keys/bundle/:userId):
 * - 200 → 'present'   (key exists; reset should be issued)
 * - 404 → 'absent'    (prior reset already landed)
 * - 401 → 'unauthorized' (prior reset revoked the JWT; skip to re-login)
 * - network/other → 'unreachable' (no destructive action)
 *
 * A Sentry breadcrumb is emitted with the outcome.
 */
export async function probeServerIdentityKey(userId: string): Promise<ServerProbeOutcome> {
  try {
    await fetchRemoteIdentityKeyBundle(userId);
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'server-probe: present',
      level: 'info',
      data: { userId },
    });
    return 'present';
  } catch (e: unknown) {
    if (e instanceof NotFoundError || (e instanceof ApiError && e.statusCode === 404)) {
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'server-probe: absent (404)',
        level: 'info',
        data: { userId },
      });
      return 'absent';
    }
    if (e instanceof AuthError && e.statusCode === 401) {
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'server-probe: unauthorized (401)',
        level: 'warning',
        data: { userId },
      });
      return 'unauthorized';
    }
    // Capture the ORIGINAL exception here so its class and stack survive
    // (DNS vs TLS vs unexpected error are indistinguishable from a wrapper).
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { feature: 'key-recovery' },
      extra: { step: 'server-probe-unreachable', userId },
    });
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'server-probe: unreachable',
      level: 'error',
      data: { userId, error: e instanceof Error ? e.message : String(e) },
    });
    return 'unreachable';
  }
}

// ---------------------------------------------------------------------------
// Login helper with 401 auto-retry (extracted from step 6)
// ---------------------------------------------------------------------------

/**
 * Attempt loginForRecovery with one auto-retry on 401 (API-M2: same-second
 * JWT revocation race). Non-401 errors propagate to the caller.
 */
export async function loginForRecoveryWithRetry(email: string, password: string): Promise<void> {
  try {
    await loginForRecovery(email, password);
  } catch (e: unknown) {
    if (e instanceof AuthError && e.statusCode === 401) {
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'login-retry: 401 auto-retry (API-M2)',
        level: 'warning',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await loginForRecovery(email, password);
      return;
    }
    throw e;
  }
}

/**
 * Detect whether a prior recovery attempt already completed the local wipe.
 * Used to gate ONLY the local wipe (step 5) — server reset decisions now use
 * `probeServerIdentityKey` instead of this local-only check.
 *
 * Primary indicator: identityKeyPublic item absent (fullCryptoWipe DELETEs items).
 * Secondary: Keychain identity private key absent (first wipe op — most durable
 * under partial failure per CRYPTO-M2).
 */
function isLocalCryptoWiped(): boolean {
  if (!isDatabaseInitialized()) return true;
  const pubKey = getItem('identityKeyPublic');
  if (pubKey === null) return true;
  if (getCachedIdentityPrivateKeyHex() === null) return true;
  return false;
}

/**
 * Resolve the email address for re-login during recovery.
 *
 * Priority (EMAIL RULING):
 * 1. Transient auth-slice email (set at login/signup from INPUT param)
 * 2. getMe() cold-start fallback (JWT still valid at 409-detection time)
 * 3. null — caller must handle (editable field in UI as last resort)
 */
async function resolveRecoveryEmail(): Promise<string | null> {
  const sliceEmail = useAppStore.getState().email;
  if (sliceEmail) return sliceEmail;

  try {
    const profile = await users.getMe();
    if (profile.email) return profile.email;
  } catch {
    // JWT may already be revoked — fall through
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

// Single-flight coalescing — see exported wrapper below.
let recoveryInflight: Promise<KeyRecoveryResult> | null = null;

/**
 * Recover identity keys after a 409 conflict or identity_key_reset push.
 *
 * **Single-flight semantics:** If a recovery is already in progress, the
 * second caller receives the same promise (its arguments are silently dropped).
 * This is safe because current call sites (KeyConflictScreen, SettingsScreen
 * double-tap) converge on the same end-state (fresh keys + reconnect).
 *
 * CAUTION: `skipServerReset` is the argument whose silent drop would be unsafe
 * for a *future* concurrent caller that disagrees — coalescing a `true` call
 * into an in-flight `false` run could re-trigger the SEC-H1 feedback loop.
 * Today no code path does this; document and revisit if that changes.
 *
 * @param password  User's current password for server re-authentication
 * @param skipServerReset
 *   - false (default): calls POST /v1/keys/reset (locally-detected conflict or settings row)
 *   - true: skips server reset entirely (push-triggered conflict — the OTHER device
 *     already reset; calling reset again would NULL that device's new key and create
 *     a feedback loop per SEC-H1)
 *
 * Steps:
 *   1. Capture email for re-login
 *   2. Disconnect WebSocket
 *   3. Cancel any in-flight key initialization (CRYPTO-H2: await orphaned promise)
 *   4. If !skipServerReset: probe server for identity key (Fix 2c loop-breaker).
 *      'present' → call resetIdentityKeys REGARDLESS of local wipe state.
 *      'absent' → skip (reset already landed). 'unauthorized' → skip (prior
 *      reset revoked JWT). 'unreachable' → return error, no destructive action.
 *   5. Local crypto wipe — gated by isLocalCryptoWiped() (local-only check).
 *      fullCryptoWipe deletes rows but preserves the live db handle and the
 *      Keychain DATABASE_ENCRYPTION_KEY — cold-start retry re-inits via bootstrap
 *      normally. This is NOT localWipe which closes + unlinks the DB file (CRYPTO-M1).
 *   6. Re-login via loginForRecoveryWithRetry (auto-retry on 401, API-M2).
 *   6b. Post-re-login safety net: re-probe with fresh JWT; if still 'present'
 *       and !skipServerReset, reset + re-login again.
 *   7. ensureKeysInitialized (un-swallowed — a second 409 leaves conflict flag true)
 *   8. Clear flags, reconnect WS, run remaining bootstrap steps
 */
export function recoverIdentityKeys(
  password: string,
  skipServerReset: boolean = false,
  emailOverride?: string,
): Promise<KeyRecoveryResult> {
  if (recoveryInflight) {
    if (__DEV__) console.warn('[KeyRecovery] Recovery already in flight — coalescing');
    return recoveryInflight;
  }

  // Clear any stale error from a previous attempt so the UI starts fresh.
  useAppStore.getState().setKeyRecoveryError(null);

  recoveryInflight = doRecoverIdentityKeys(password, skipServerReset, emailOverride)
    .then((result) => {
      // Hoist non-success result to the store so the (re)mounted UI can display it.
      if (result.status !== 'success') {
        useAppStore
          .getState()
          .setKeyRecoveryError(
            result.status === 'incorrect_password' || result.status === 'rate_limited'
              ? { status: result.status }
              : { status: result.status, message: (result as { message?: string }).message },
          );
      }
      return result;
    })
    .finally(() => {
      recoveryInflight = null;
    });
  return recoveryInflight;
}

async function doRecoverIdentityKeys(
  password: string,
  skipServerReset: boolean = false,
  emailOverride?: string,
): Promise<KeyRecoveryResult> {
  setRecoveryInitiator(true);
  useAppStore.getState().setKeyRecoveryInProgress(true);

  try {
    // Step 1: Capture email before any wipe.
    // emailOverride is the manual-entry fallback from KeyConflictScreen (EMAIL RULING tier 3).
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-1: resolving email',
      level: 'info',
    });
    const email = emailOverride || (await resolveRecoveryEmail());
    if (!email) {
      Sentry.captureMessage('Key recovery: email unresolvable (needs_email)', {
        level: 'warning',
        tags: { feature: 'key-recovery' },
      });
      return {
        status: 'needs_email' as const,
        message: 'Unable to determine account email for re-login',
      };
    }

    // Step 2: Disconnect WS — prevent stale reconnects during reset
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-2: disconnecting WS',
      level: 'info',
    });
    websocketManager.disconnect();

    // Step 3: Cancel in-flight key initialization (CRYPTO-H2)
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-3: cancelling key init',
      level: 'info',
    });
    await cancelKeyInitialization();

    const locallyWiped = isLocalCryptoWiped();
    const ownUserId = useAppStore.getState().userId;

    // Step 4: Server reset — now driven by server-truth probe (Fix 2c)
    // instead of the local-only isAlreadyWiped check that caused the stuck loop.
    if (!skipServerReset && ownUserId) {
      const probeResult = await probeServerIdentityKey(ownUserId);
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'step-4: pre-reset state',
        level: 'info',
        data: { skipServerReset, locallyWiped, probeResult },
      });

      if (probeResult === 'unreachable') {
        // No destructive action on network failure — safe bail. The original
        // exception was already captured inside probeServerIdentityKey.
        websocketManager.connect();
        return { status: 'error', message: 'Network error — please check your connection' };
      }

      if (probeResult === 'present') {
        // Key still on server — reset REGARDLESS of local wipe state.
        // This is the loop-breaker: prod logs show the stuck tester's device
        // never sent a reset because a prior local wipe made isAlreadyWiped true.
        try {
          await resetIdentityKeys(password);
          Sentry.addBreadcrumb({
            category: 'key-recovery',
            message: 'step-4: server reset succeeded',
            level: 'info',
          });
        } catch (e: unknown) {
          // 403 → incorrect password — nothing was wiped, safe to abort
          if (e instanceof AuthError && e.statusCode === 403) {
            Sentry.captureMessage('Key recovery: incorrect password (403)', {
              level: 'warning',
              tags: { feature: 'key-recovery' },
            });
            websocketManager.connect();
            return { status: 'incorrect_password' };
          }
          // Rate limited — client.ts throws plain ApiError for 429 (not AuthError)
          if (e instanceof ApiError && e.statusCode === 429) {
            Sentry.captureMessage('Key recovery: rate limited (429)', {
              level: 'warning',
              tags: { feature: 'key-recovery' },
            });
            websocketManager.connect();
            return { status: 'rate_limited' };
          }
          if (e instanceof NetworkError) {
            Sentry.captureException(e, {
              tags: { feature: 'key-recovery' },
              extra: { step: 'server-reset' },
            });
            websocketManager.connect();
            return { status: 'error', message: 'Network error — please check your connection' };
          }
          Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
            tags: { feature: 'key-recovery' },
            extra: { step: 'server-reset' },
          });
          websocketManager.connect();
          return { status: 'error', message: e instanceof Error ? e.message : 'Reset failed' };
        }
      }
      // 'absent' → reset already landed, skip
      // 'unauthorized' → prior reset revoked JWT, skip to re-login
    } else if (!skipServerReset) {
      // No userId available — cannot probe; fall through to re-login
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'step-4: skipped probe (no userId)',
        level: 'warning',
        data: { skipServerReset, locallyWiped },
      });
    } else {
      // skipServerReset === true (SEC-H1 push path) — never reset
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'step-4: skipped (SEC-H1 skipServerReset)',
        level: 'info',
        data: { skipServerReset, locallyWiped },
      });
    }

    // Step 5: Local crypto wipe — gated ONLY by local state (isLocalCryptoWiped)
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-5: local wipe',
      level: 'info',
      data: { locallyWiped },
    });
    if (!locallyWiped) {
      try {
        await fullCryptoWipe();
      } catch (e: unknown) {
        Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
          tags: { feature: 'key-recovery' },
          extra: { step: 'local-wipe' },
        });
        return { status: 'error', message: 'Local wipe failed — please retry' };
      }

      // Clear in-flight service state that references now-dead crypto material
      try {
        clearConversationServiceState();
      } catch {
        /* best-effort */
      }
      try {
        clearIdentityInflightState();
      } catch {
        /* best-effort */
      }
      try {
        clearMessageHandlerState();
      } catch {
        /* best-effort */
      }

      // Defense-in-depth: explicitly remove load-bearing items that fullCryptoWipe
      // already deleted via DELETE FROM items. These explicit calls ensure the
      // dependency survives any future narrowing of fullCryptoWipe's scope.
      if (isDatabaseInitialized()) {
        try {
          removeItem('lastUserId');
        } catch {
          /* may already be gone */
        }
        try {
          removeItem('bundleUploaded');
        } catch {
          /* may already be gone */
        }
      }
    }

    // Server deleted all archive confirmations on key reset (all three recovery
    // shapes) — clear local flags so the sweep re-confirms; over-clearing is
    // idempotent, under-clearing silently defeats the wiped-phone eviction guard.
    try {
      clearAllArchiveConfirmations();
    } catch {
      /* best-effort */
    }

    // Step 6: Re-login (loginForRecoveryWithRetry — extracted 401 auto-retry)
    Sentry.addBreadcrumb({ category: 'key-recovery', message: 'step-6: re-login', level: 'info' });
    try {
      await loginForRecoveryWithRetry(email, password);
    } catch (e: unknown) {
      Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
        tags: { feature: 'key-recovery' },
        extra: {
          step:
            e instanceof AuthError && e.statusCode === 401
              ? 're-login-retry-exhausted'
              : 're-login',
        },
      });
      return {
        status: 'error',
        message: e instanceof Error ? e.message : 'Re-login failed',
      };
    }

    // Step 6b: Post-re-login safety net (Fix 2c)
    // Re-probe with the fresh JWT; if the key is still 'present' and we're
    // allowed to reset, do so — then re-login again (reset revokes the fresh JWT).
    if (!skipServerReset && ownUserId) {
      const postLoginProbe = await probeServerIdentityKey(ownUserId);
      Sentry.addBreadcrumb({
        category: 'key-recovery',
        message: 'step-6b: post-login re-probe',
        level: 'info',
        data: { postLoginProbe },
      });

      if (postLoginProbe === 'present') {
        let postLoginResetSucceeded = false;
        try {
          await resetIdentityKeys(password);
          postLoginResetSucceeded = true;
          Sentry.addBreadcrumb({
            category: 'key-recovery',
            message: 'step-6b: post-login reset succeeded',
            level: 'info',
          });
        } catch (e: unknown) {
          // Non-fatal — proceed on the still-valid JWT; the second-409 branch
          // below catches a still-present server key.
          Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
            tags: { feature: 'key-recovery' },
            extra: { step: 'post-login-reset' },
          });
        }

        // Only a SUCCESSFUL reset revokes the fresh JWT; skip the extra
        // re-login when the reset failed (current token is still valid).
        if (postLoginResetSucceeded) {
          Sentry.addBreadcrumb({
            category: 'key-recovery',
            message: 'step-6b: re-login after post-login reset',
            level: 'info',
          });
          try {
            await loginForRecoveryWithRetry(email, password);
          } catch (e: unknown) {
            Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
              tags: { feature: 'key-recovery' },
              extra: { step: 'post-login-re-login' },
            });
            return {
              status: 'error',
              message: e instanceof Error ? e.message : 'Re-login failed after post-login reset',
            };
          }
        }
      }
    }

    // Step 7: Generate + upload new keys (un-swallowed — a second 409 must
    // LEAVE the conflict flag true so the user doesn't land in a broken app)
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-7: key re-generation',
      level: 'info',
    });
    try {
      await ensureKeysInitialized();
    } catch (e: unknown) {
      if (e instanceof ConflictError) {
        // Second 409 — leave conflict flag true, abort recovery
        Sentry.captureException(e, {
          tags: { feature: 'key-recovery' },
          extra: { step: 'second-409-conflict-persists' },
        });
        useAppStore.getState().setIdentityKeyConflict(true);
        useAppStore.getState().setConflictSource('local');
        return {
          status: 'error',
          message: 'Key conflict persists after recovery — please try again',
        };
      }
      Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
        tags: { feature: 'key-recovery' },
        extra: { step: 'key-init' },
      });
      return {
        status: 'error',
        message: e instanceof Error ? e.message : 'Key initialization failed',
      };
    }

    // Step 8: Clear flags, reconnect, run remaining bootstrap steps
    Sentry.addBreadcrumb({
      category: 'key-recovery',
      message: 'step-8: post-recovery bootstrap',
      level: 'info',
    });
    useAppStore.getState().setIdentityKeyConflict(false);
    useAppStore.getState().setConflictSource(null);

    websocketManager.connect();

    // SYNC:postAuthBootstrap — these mirror authService.ts postAuthBootstrap().
    // If you change one, update the other. Grep for this marker to find both.
    // Each is catch-guarded so a single failure doesn't abort the rest.
    // warnAndCapture (not warnCatch): post-recovery sync failures must be
    // visible in Sentry — a successful recovery with a failed sync is a
    // production-silent data inconsistency (panel finding).
    try {
      loadEciesLockState();
    } catch (e) {
      warnAndCapture('[Recovery:EciesLock]')(e);
    }
    await loadConversations().catch(warnAndCapture('[Recovery:ConversationSync]'));
    await loadDmConversations().catch(warnAndCapture('[Recovery:DmSync]'));
    hydrateContactsFromOrbits().catch(warnAndCapture('[Recovery:ContactHydration]'));
    fulfillPendingWraps().catch(warnAndCapture('[Recovery:PendingWraps]'));
    syncBlockedUsers().catch(warnAndCapture('[Recovery:BlockedUsersSync]'));

    return { status: 'success' };
  } finally {
    setRecoveryInitiator(false);
    useAppStore.getState().setKeyRecoveryInProgress(false);
  }
}
