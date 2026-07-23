/**
 * Identity restore service — seamless Keychain identity recovery on reinstall.
 *
 * On iOS, the Keychain survives app uninstall. When the user reinstalls, the
 * identity private key (and ACCESS_TOKEN) may still be present even though the
 * SQLCipher database (holding identityKeyPublic) is gone. This service detects
 * that scenario and restores the identity without triggering a key conflict.
 *
 * ## Decision table
 *
 * | DB pub key | Keychain priv | Server bundle | ECIES proof | Result     |
 * |------------|---------------|---------------|-------------|------------|
 * | present    | *             | *             | *           | 'none'     |
 * | absent     | absent        | *             | *           | 'none'     |
 * | absent     | present       | 404           | *           | 'cleared'  |
 * | absent     | present       | network err   | *           | 'deferred' |
 * | absent     | present       | 200           | match       | 'restored' |
 * | absent     | present       | 200           | mismatch    | 'cleared'  |
 * | absent     | present       | 200           | other error | 'deferred' |
 *
 * ## Round-trip proof contract
 *
 * Uses eciesSeal/eciesOpen DIRECTLY from orbital-signal (NOT the contentCrypto
 * wrappers which call getIdentityKeyPair() — that throws when identityKeyPublic
 * is absent from the wiped DB).
 *
 * - Plaintext: crypto.getRandomValues(new Uint8Array(32)) — exactly 32 bytes
 * - group_id: fixed UTF-8 string 'identity-verify-probe' for BOTH seal and open
 *   (mismatched contexts would false-negative and discard a valid key)
 *
 * ## Error taxonomy
 *
 * Only the ECIES InvalidArgument "does not match" case maps to mismatch -> 'cleared'.
 * Every other error (InvalidKey, InternalError, anything unexpected) throws to
 * the outer catch -> 'deferred'. A transient/malformed-state failure must never
 * discard the surviving key.
 *
 * ## Sentry telemetry
 *
 * This module lives in the crypto/ path where the no-restricted-imports eslint
 * rule forbids Sentry imports (prevents key material leakage). All Sentry
 * breadcrumbs/captures are performed by the caller (authService.ts) based on
 * the returned result discriminant.
 *
 * @module identityRestoreService
 */

import { eciesSeal, eciesOpen, SignalError_Tags } from 'orbital-signal';
import { fetchRemoteIdentityKeyBundle } from '../api/keys';
import { NotFoundError } from '../api/errors';
import { getItem } from '../../database/repositories/itemRepository';
import {
  getCachedIdentityPrivateKeyHex,
  clearIdentityKeyCache,
  restoreIdentityKeys,
} from './keyGenerationService';
import { removeSecureItem } from '../secure-storage';
import { SecureKeys } from '../secure-storage/constants';
import {
  hexToUint8Array,
  toArrayBuffer,
  base64ToArrayBuffer,
  encodeUTF8,
} from './utils';
import { normalizeIdentityKey } from './identityKeyAccess';
import { useAppStore } from '../../stores/useAppStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed domain-separation context for the ECIES round-trip proof. */
const VERIFY_PROBE_CONTEXT = 'identity-verify-probe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IdentityRestoreResult = 'restored' | 'cleared' | 'none' | 'deferred';

// ---------------------------------------------------------------------------
// Core: round-trip proof
// ---------------------------------------------------------------------------

/**
 * Verify that a cached private key matches a server-held public key via
 * an ECIES seal+open round-trip.
 *
 * Returns true on match, false on ECIES InvalidArgument (key mismatch).
 * Throws on any other error (caller treats as 'deferred').
 */
function verifyPrivateKeyMatchesPublic(
  privHex: string,
  serverKeyB64: string,
): boolean {
  const privateKeyBytes = hexToUint8Array(privHex);
  const privateKey = toArrayBuffer(privateKeyBytes);

  // Decode server public key and normalize to 33-byte Signal format
  const serverKeyDecoded = new Uint8Array(base64ToArrayBuffer(serverKeyB64));
  const publicKey = toArrayBuffer(normalizeIdentityKey(serverKeyDecoded));

  // Domain-separation context (UTF-8 encoded)
  const contextBytes = toArrayBuffer(encodeUTF8(VERIFY_PROBE_CONTEXT));

  // Generate 32-byte random plaintext for the proof
  const plaintext = new Uint8Array(32);
  const cryptoGlobal = (
    globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => void } }
  ).crypto;
  cryptoGlobal.getRandomValues(plaintext);
  const plaintextBuf = toArrayBuffer(plaintext);

  // Seal: encrypt to self (recipient = own public key)
  const sealed = eciesSeal(
    plaintextBuf,
    contextBytes,
    publicKey,     // recipient = our own public key
    privateKey,    // sender private = our private key
    publicKey,     // sender public = our own public key
  );

  // Open: decrypt with our private key, verifying sender = our public key
  try {
    eciesOpen(
      sealed,
      contextBytes,
      privateKey,    // recipient secret key
      publicKey,     // expected sender public key
    );
    return true;
  } catch (err: unknown) {
    // ONLY InvalidArgument maps to mismatch
    if (
      err != null &&
      typeof err === 'object' &&
      'tag' in err &&
      (err as { tag: string }).tag === SignalError_Tags.InvalidArgument
    ) {
      return false;
    }
    // Everything else (InvalidKey, InternalError, etc.) -> rethrow
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core: clear stale keychain identity
// ---------------------------------------------------------------------------

/**
 * Clear a stale Keychain identity key AND the in-memory cache.
 *
 * Used by:
 * - Restore mismatch / 404 paths (surviving key has no residual value)
 * - signupUser (new account can never restore; previously silently overwritten)
 *
 * Must clear BOTH: a warm cachedPrivateKeyHex alone would trip the
 * defense-in-depth invariant in generateInitialKeys and break signup
 * on any previously-keyed device.
 */
export async function clearStaleKeychainIdentity(): Promise<void> {
  await removeSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE).catch(() => {});
  clearIdentityKeyCache();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attempt to restore the identity from a surviving Keychain private key
 * after a reinstall (DB wiped, Keychain intact).
 *
 * Must be the FIRST step in postAuthBootstrap(). Requires a password-authed
 * session (login/signup already completed).
 *
 * Security gates: restore requires (1) server-side password auth for account X,
 * (2) device Keychain possession, (3) cryptographic proof key matches X's
 * registered public key. Mismatch NEVER restores. Transient failures NEVER
 * discard the surviving key.
 */
export async function attemptKeychainIdentityRestore(): Promise<IdentityRestoreResult> {
  // --- 'none' fast paths ---

  // If DB already has identityKeyPublic, this is a normal login (not a reinstall)
  const existingPub = getItem('identityKeyPublic');
  if (existingPub !== null) {
    return 'none';
  }

  // If no cached private key, nothing to restore
  const privHex = getCachedIdentityPrivateKeyHex();
  if (privHex === null) {
    return 'none';
  }

  // Need userId to probe server
  const userId = useAppStore.getState().userId;
  if (!userId) {
    return 'none';
  }

  // --- Probe server for the registered public key ---
  let serverKeyB64: string;
  try {
    const bundle = await fetchRemoteIdentityKeyBundle(userId);
    serverKeyB64 = bundle.identityKey;
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      // 404 -> server key is NULL (prior reset landed; surviving key has no
      // residual value) -> clear Keychain + cache -> fresh generateInitialKeys
      await clearStaleKeychainIdentity();
      return 'cleared';
    }

    // Network or any other error -> 'deferred'
    // Fail-safe: NEVER fall through to key generation while network is flaky;
    // surviving key must not be overwritten.
    return 'deferred';
  }

  // --- ECIES round-trip proof ---
  let match: boolean;
  try {
    match = verifyPrivateKeyMatchesPublic(privHex, serverKeyB64);
  } catch {
    // Non-mismatch ECIES error -> 'deferred' (never discard on ambiguous failure)
    return 'deferred';
  }

  if (match) {
    // Private key matches server public key -> restore identity
    await restoreIdentityKeys(serverKeyB64);
    return 'restored';
  }

  // Mismatch (different account logged into server vs Keychain) -> clear
  await clearStaleKeychainIdentity();
  return 'cleared';
}
