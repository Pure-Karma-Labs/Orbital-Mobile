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

import { useAppStore } from '../stores/useAppStore';
import { loginForRecovery } from './authService';
import { resetIdentityKeys } from './api/keys';
import * as users from './api/users';
import { AuthError, NetworkError } from './api/errors';
import { ConflictError } from './api/errors';
import {
  fullCryptoWipe,
  cancelKeyInitialization,
  ensureKeysInitialized,
  getCachedIdentityPrivateKeyHex,
} from './crypto/keyGenerationService';
import { getItem, removeItem } from '../database/repositories/itemRepository';
import { isDatabaseInitialized } from '../database/connection';
import { clearConversationServiceState } from './conversationService';
import { clearIdentityInflightState } from './crypto/identityKeyAccess';
import { clearMessageHandlerState } from './websocket/messageHandler';
import { loadEciesLockState } from './crypto/downgradeProtection';
import { loadConversations, loadDmConversations, fulfillPendingWraps, hydrateContactsFromOrbits } from './conversationService';
import { syncBlockedUsers } from './blockedUsersSync';
import { websocketManager } from './websocket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyRecoveryResult =
  | { status: 'success' }
  | { status: 'incorrect_password' }
  | { status: 'rate_limited' }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Transient initiator flag — #539 reads this to suppress self-push
// ---------------------------------------------------------------------------

let _isRecoveryInitiator = false;

/** True while THIS device is executing a recovery flow. #539 uses this to
 *  suppress the identity_key_reset push handler on the initiating device. */
export function isRecoveryInitiator(): boolean {
  return _isRecoveryInitiator;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warnCatch(tag: string) {
  return (e: unknown) => {
    if (__DEV__) console.warn(tag, e instanceof Error ? e.message : e);
  };
}

/**
 * Detect whether a prior recovery attempt already completed the server reset
 * and local wipe but failed before re-login finished. In that state, calling
 * POST /v1/keys/reset would 401 (JWT revoked) — so we skip directly to re-login.
 *
 * Primary indicator: identityKeyPublic item absent (fullCryptoWipe DELETEs items).
 * Secondary: Keychain identity private key absent (first wipe op — most durable
 * under partial failure per CRYPTO-M2).
 */
function isAlreadyWiped(): boolean {
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

/**
 * Recover identity keys after a 409 conflict or identity_key_reset push.
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
 *   4. If !skipServerReset && !alreadyWiped: POST /v1/keys/reset
 *   5. fullCryptoWipe + clear inflight state + explicit removeItem (defense-in-depth)
 *      NOTE: fullCryptoWipe deletes rows but preserves the live db handle and the
 *      Keychain DATABASE_ENCRYPTION_KEY — cold-start retry re-inits via bootstrap
 *      normally. This is NOT localWipe which closes + unlinks the DB file (CRYPTO-M1).
 *   6. Re-login (loginForRecovery — no postAuthBootstrap)
 *      On 401: auto-retry once after ~1.5s (API-M2 — same-second JWT revocation race)
 *   7. ensureKeysInitialized (un-swallowed — a second 409 leaves conflict flag true)
 *   8. Clear flags, reconnect WS, run remaining bootstrap steps
 *
 * State-aware retry: if local identity key is already absent (steps 4-5 committed
 * but step 6+ failed on a prior attempt), skip directly to step 6. This prevents
 * the JWT catch-22 where re-running reset would 401 against a revoked token.
 */
export async function recoverIdentityKeys(
  password: string,
  skipServerReset: boolean = false,
): Promise<KeyRecoveryResult> {
  _isRecoveryInitiator = true;
  useAppStore.getState().setKeyRecoveryInProgress(true);

  try {
    // Step 1: Capture email before any wipe
    const email = await resolveRecoveryEmail();
    if (!email) {
      return { status: 'error', message: 'Unable to determine account email for re-login' };
    }

    // Step 2: Disconnect WS — prevent stale reconnects during reset
    websocketManager.disconnect();

    // Step 3: Cancel in-flight key initialization (CRYPTO-H2)
    await cancelKeyInitialization();

    const alreadyWiped = isAlreadyWiped();

    // Step 4: Server reset (if applicable)
    if (!skipServerReset && !alreadyWiped) {
      try {
        await resetIdentityKeys(password);
      } catch (e: unknown) {
        // 403 → incorrect password — nothing was wiped, safe to abort
        if (e instanceof AuthError && e.statusCode === 403) {
          websocketManager.connect();
          return { status: 'incorrect_password' };
        }
        // Rate limited — surface friendly message
        if (e instanceof AuthError && e.statusCode === 429) {
          websocketManager.connect();
          return { status: 'rate_limited' };
        }
        if (e instanceof NetworkError) {
          websocketManager.connect();
          return { status: 'error', message: 'Network error — please check your connection' };
        }
        websocketManager.connect();
        return { status: 'error', message: e instanceof Error ? e.message : 'Reset failed' };
      }
    }

    // Step 5: Local crypto wipe (flows through fullCryptoWipe — documented subset
    // of localWipe per DEBT-005; NOT a parallel re-enumeration)
    if (!alreadyWiped) {
      await fullCryptoWipe();

      // Clear in-flight service state that references now-dead crypto material
      try { clearConversationServiceState(); } catch { /* best-effort */ }
      try { clearIdentityInflightState(); } catch { /* best-effort */ }
      try { clearMessageHandlerState(); } catch { /* best-effort */ }

      // Defense-in-depth: explicitly remove load-bearing items that fullCryptoWipe
      // already deleted via DELETE FROM items. These explicit calls ensure the
      // dependency survives any future narrowing of fullCryptoWipe's scope.
      if (isDatabaseInitialized()) {
        try { removeItem('lastUserId'); } catch { /* may already be gone */ }
        try { removeItem('bundleUploaded'); } catch { /* may already be gone */ }
      }
    }

    // Step 6: Re-login (loginForRecovery — no postAuthBootstrap)
    // API-M2: same-second JWT revocation race — backend revokes JWTs with
    // iat <= password_changed_at at SECOND granularity. If reset(step4) and
    // login(step6) complete within the same second (~30-50%), the new JWT's
    // iat matches the revocation threshold. Auto-retry once after ~1.5s.
    try {
      await loginForRecovery(email, password);
    } catch (e: unknown) {
      if (e instanceof AuthError && e.statusCode === 401) {
        // Auto-retry once after 1.5s delay (API-M2)
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        try {
          await loginForRecovery(email, password);
        } catch (retryErr: unknown) {
          return {
            status: 'error',
            message: retryErr instanceof Error ? retryErr.message : 'Re-login failed after retry',
          };
        }
      } else {
        return {
          status: 'error',
          message: e instanceof Error ? e.message : 'Re-login failed',
        };
      }
    }

    // Step 7: Generate + upload new keys (un-swallowed — a second 409 must
    // LEAVE the conflict flag true so the user doesn't land in a broken app)
    try {
      await ensureKeysInitialized();
    } catch (e: unknown) {
      if (e instanceof ConflictError) {
        // Second 409 — leave conflict flag true, abort recovery
        useAppStore.getState().setIdentityKeyConflict(true);
        useAppStore.getState().setConflictSource('local');
        return { status: 'error', message: 'Key conflict persists after recovery — please try again' };
      }
      return {
        status: 'error',
        message: e instanceof Error ? e.message : 'Key initialization failed',
      };
    }

    // Step 8: Clear flags, reconnect, run remaining bootstrap steps
    useAppStore.getState().setIdentityKeyConflict(false);
    useAppStore.getState().setConflictSource(null);

    websocketManager.connect();

    // Run bootstrap steps that postAuthBootstrap would normally handle.
    // Each is catch-guarded so a single failure doesn't abort the rest.
    loadEciesLockState();
    await loadConversations().catch(warnCatch('[Recovery:ConversationSync]'));
    await loadDmConversations().catch(warnCatch('[Recovery:DmSync]'));
    hydrateContactsFromOrbits().catch(warnCatch('[Recovery:ContactHydration]'));
    fulfillPendingWraps().catch(warnCatch('[Recovery:PendingWraps]'));
    syncBlockedUsers().catch(warnCatch('[Recovery:BlockedUsersSync]'));

    return { status: 'success' };
  } finally {
    _isRecoveryInitiator = false;
    useAppStore.getState().setKeyRecoveryInProgress(false);
  }
}
