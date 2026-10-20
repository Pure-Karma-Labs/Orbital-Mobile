/**
 * contentCrypto — AES-256-GCM content encryption/decryption for threads and replies.
 *
 * Wraps the Rust `aes_gcm_encrypt` / `aes_gcm_decrypt` functions exposed via uniffi.
 * Handles UTF-8 and base64 encoding at the TypeScript boundary — the Rust layer
 * works exclusively with raw bytes.
 *
 * **Wire format (matches Orbital-Desktop):**
 * - Ciphertext: base64-encoded `encrypted_data || 16-byte auth tag`
 * - IV: base64-encoded 12-byte nonce
 * - AAD: groupId as UTF-8 bytes (binds ciphertext to the group, prevents cross-group replay)
 *
 * SECURITY: Group keys are cached in memory for performance. The cache is zero-filled
 * on logout via `clearGroupKeyCache()`. Key material is never logged.
 */

import { aesGcmEncrypt, aesGcmDecrypt, eciesSeal, eciesOpen } from 'orbital-signal';
import type { ContentCryptoResult } from 'orbital-signal';
import { getGroupKey } from '../api/groups';
import {
  getGroupMasterKey,
  setGroupMasterKey,
  clearGroupMasterKey,
} from '../../database/repositories/conversationRepository';
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from './utils';
import { getIdentityKeyPair, resolveRemoteIdentityKey } from './identityKeyAccess';
import { markEciesLocked, isEciesLocked } from './downgradeProtection';
import {
  classifyEciesOpenError,
  GroupKeyUnwrapError,
  reportGroupKeyFailure,
} from './groupKeyErrors';
import type { GroupKeyErrorCode } from './groupKeyErrors';
import {
  clearAllPendingWraps,
  clearPendingWrap,
  isPendingWrapPastBound,
  notePendingWrap,
} from './pendingWrapClock';
import { recoverDeadEnvelope, resetGroupKeyRecoveryState } from './groupKeyRecovery';
import { clearWrapDeliveryDedup } from './wrapDeliveryHook';
import { useAppStore } from '../../stores/useAppStore';

// ---------------------------------------------------------------------------
// Text encoder/decoder
// ---------------------------------------------------------------------------

function encodeUTF8(str: string): Uint8Array {
  const arr: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      arr.push(c);
    } else if (c < 0x800) {
      arr.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      arr.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      arr.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(arr);
}

function decodeUTF8(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { result += String.fromCharCode(b); i++; }
    else if (b < 0xe0) { result += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b < 0xf0) { result += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else { const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); result += String.fromCodePoint(cp); i += 4; }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Group key cache + persistence
// ---------------------------------------------------------------------------

const groupKeyCache = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array>>();

function validateAndDecode(keyBase64: string): Uint8Array {
  const keyBytes = new Uint8Array(base64ToArrayBuffer(keyBase64));
  if (keyBytes.length !== 32) {
    throw new Error(`Invalid group key length: expected 32, got ${keyBytes.length}`);
  }
  return keyBytes;
}

/**
 * Persist a group key from a base64 string (e.g. from API response).
 * Validates the key is exactly 32 bytes, stores as BLOB in SQLCipher
 * conversations.group_master_key, and populates the in-memory cache.
 *
 * If the key is not valid base64 or not 32 bytes (e.g. legacy placeholder),
 * generates a fresh 32-byte key instead.
 */
export function persistGroupKey(groupId: string, keyBase64: string): void {
  const keyBytes = validateAndDecode(keyBase64);
  groupKeyCache.set(groupId, keyBytes);
  // The wait is over: a group with a usable key has no pending-wrap entry
  // (#937). One of the three sites where that invariant is restored.
  clearPendingWrap(groupId);
  try {
    setGroupMasterKey(groupId, keyBytes);
  } catch {
    // Database may not be initialized yet — key is still in memory cache
  }
}

// ---------------------------------------------------------------------------
// ECIES key wrapping
// ---------------------------------------------------------------------------

const ECIES_ENVELOPE_LEN = 190;
const ECIES_VERSION_BYTE = 0x02;

export function detectKeyFormat(keyBase64: string): 'raw' | 'ecies' {
  const bytes = new Uint8Array(base64ToArrayBuffer(keyBase64));
  if (bytes.length === 32) return 'raw';
  if (bytes.length === ECIES_ENVELOPE_LEN && bytes[0] === ECIES_VERSION_BYTE) return 'ecies';
  throw new Error(`Unknown key format: ${bytes.length} bytes`);
}

export function wrapGroupKey(
  groupKey: Uint8Array,
  recipientPubKey: ArrayBuffer,
  groupId: string,
): string {
  const { privateKey, publicKey } = getIdentityKeyPair();
  const groupIdBytes = toArrayBuffer(encodeUTF8(groupId));
  const sealed = eciesSeal(
    toArrayBuffer(groupKey),
    groupIdBytes,
    recipientPubKey,
    privateKey,
    publicKey,
  );
  return arrayBufferToBase64(sealed);
}

export function unwrapGroupKey(
  wrappedBase64: string,
  senderPubKey: ArrayBuffer,
  groupId: string,
): Uint8Array {
  const { privateKey } = getIdentityKeyPair();
  const sealed = base64ToArrayBuffer(wrappedBase64);
  const groupIdBytes = toArrayBuffer(encodeUTF8(groupId));
  const plaintext = eciesOpen(sealed, groupIdBytes, privateKey, senderPubKey);
  return new Uint8Array(plaintext);
}

export async function processReceivedGroupKey(
  groupId: string,
  wrappedGroupKey: string,
  wrappedBy: string | null,
): Promise<void> {
  const format = detectKeyFormat(wrappedGroupKey);

  if (format === 'ecies') {
    if (!wrappedBy) {
      throw new Error('ECIES envelope requires sender identity');
    }
    const currentUserId = useAppStore.getState().userId;
    if (!currentUserId) {
      throw new Error('No authenticated user');
    }
    const senderPubKey = await resolveRemoteIdentityKey(wrappedBy, currentUserId);
    const rawKey = unwrapGroupKey(wrappedGroupKey, senderPubKey, groupId);
    markEciesLocked(groupId);
    persistGroupKey(groupId, arrayBufferToBase64(toArrayBuffer(rawKey)));
    return;
  }

  if (isEciesLocked(groupId)) {
    throw new Error('Downgrade rejected: group is ECIES-locked');
  }
  persistGroupKey(groupId, wrappedGroupKey);
}

/**
 * Load a group key from SQLCipher (conversations.group_master_key BLOB).
 * Returns null if the conversation doesn't exist or has no key stored.
 */
export function loadPersistedGroupKey(groupId: string): Uint8Array | null {
  const key = getGroupMasterKey(groupId);
  if (!key || key.length !== 32) return null;
  return key;
}

/**
 * Populate the in-memory group key cache without persisting to SQLCipher.
 * Used by selfWrapIfNeeded to make the key available to concurrent
 * getOrFetchGroupKey callers while the network self-wrap call is in-flight.
 */
export function setCachedGroupKey(groupId: string, key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`Invalid group key length: expected 32, got ${key.length}`);
  }
  groupKeyCache.set(groupId, key);
  clearPendingWrap(groupId);
}

/**
 * Get the group key for a groupId. Three-tier lookup:
 * 1. In-memory cache (fastest)
 * 2. SQLCipher BLOB (survives app restart)
 * 3. API fallback (last resort — may return wrong key for non-creators)
 *
 * SQLCipher is authoritative: if a key is persisted, it is used even if
 * the API would return a different value. The API only seeds empty slots.
 *
 * Concurrent calls for the same groupId coalesce onto a single request.
 *
 */
/**
 * Groups short-circuited for the TTL below, with the CAUSE that stamped them:
 * the 30-second gate re-raises the error, so it has to re-raise the right one
 * (#937). `no_envelope` for the two "there was no key" stamps, the classified
 * code for the self-heal's `requested`.
 */
const pendingGroups = new Map<string, { until: number; code: GroupKeyErrorCode }>();
const PENDING_CACHE_TTL_MS = 30_000;

/**
 * Thrown when a group key is not yet available because the wrap from another
 * member hasn't been delivered. Transient — callers may retry after
 * wrapped_key_delivered. Distinct from genuine decrypt failures, which are
 * permanent.
 */
export class PendingWrapError extends Error {
  constructor() {
    super('Group key not yet available (pending wrap)');
    this.name = 'PendingWrapError';
  }
}

export function evictPendingCache(groupId: string): void {
  pendingGroups.delete(groupId);
}

/** Short-circuit this group for the TTL, remembering why. */
function stampPending(groupId: string, code: GroupKeyErrorCode): void {
  pendingGroups.set(groupId, { until: Date.now() + PENDING_CACHE_TTL_MS, code });
}

/**
 * The error for "there is no usable key for this group yet": the hopeful
 * {@link PendingWrapError} while the wait is within the bound, and a
 * `stale_pending` {@link GroupKeyUnwrapError} past it (#937).
 *
 * Every pending path goes through here, so starting the clock and reading it
 * cannot drift apart. The bound changes only WHICH error is thrown — the server
 * is still fetched on the next call, and a delivery still heals the group, so a
 * key that does eventually arrive is picked up either way.
 *
 * Reports the stale verdict itself (one event per group and outcome, budgeted
 * by the reporter); the caller must not report again.
 */
function pendingOrStale(
  groupId: string,
  code: GroupKeyErrorCode,
  reportWhenPending?: GroupKeyUnwrapError,
): Error {
  const now = Date.now();
  notePendingWrap(groupId, now);
  if (!isPendingWrapPastBound(groupId, now)) {
    if (reportWhenPending !== undefined) reportGroupKeyFailure(groupId, reportWhenPending);
    return new PendingWrapError();
  }
  const stale = new GroupKeyUnwrapError(code, 'stale_pending');
  reportGroupKeyFailure(groupId, stale);
  return stale;
}

export async function getOrFetchGroupKey(groupId: string): Promise<Uint8Array> {
  const cached = groupKeyCache.get(groupId);
  if (cached) return cached;

  const pending = pendingGroups.get(groupId);
  if (pending && Date.now() < pending.until) {
    // Re-raise with the cause that stamped the TTL, so a stale verdict reported
    // from here carries the same code the stamping read reported.
    throw pendingOrStale(groupId, pending.code);
  }

  // Tier 2: persisted key. Grandfathered raw keys stored before ECIES existed
  // correctly bypass format detection and downgrade protection here.
  try {
    const persisted = loadPersistedGroupKey(groupId);
    if (persisted) {
      groupKeyCache.set(groupId, persisted);
      clearPendingWrap(groupId);
      return persisted;
    }
  } catch {
    // Database may not be initialized — fall through to API
  }

  const existing = inflight.get(groupId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const response = await getGroupKey(groupId);
      if (!response.wrappedGroupKey) {
        stampPending(groupId, 'no_envelope');
        throw pendingOrStale(groupId, 'no_envelope');
      }
      // Captured once: the envelope string is the server's compare-and-swap
      // witness for a rewrap request and must be passed on unmodified.
      const envelope = response.wrappedGroupKey;
      const wrappedBy = response.wrappedBy ?? null;
      try {
        await processReceivedGroupKey(groupId, envelope, wrappedBy);
      } catch (e) {
        if (
          e instanceof Error &&
          e.message === 'ECIES envelope requires sender identity'
        ) {
          stampPending(groupId, 'no_envelope');
          throw e;
        }

        // Tier 4: the server handed us an envelope this device cannot open
        // (#912). Reached only after tiers 1-3 missed, so a persisted key can
        // never be discarded by this path.
        const code = classifyEciesOpenError(e);
        // Not a SignalError at all — a database failure, 'No authenticated
        // user', a bug. Not a key problem; rethrow untouched.
        if (code === null) throw e;

        const result = await recoverDeadEnvelope({
          groupId,
          envelope,
          wrappedBy,
          code,
          // Deliberately NOT getOrFetchGroupKey: we are inside its in-flight
          // promise, and re-entering would self-await and hang forever.
          retryUnwrap: async () => {
            await processReceivedGroupKey(groupId, envelope, wrappedBy);
            return groupKeyCache.get(groupId) ?? null;
          },
        });

        if (result.outcome !== 'healed') {
          const failure = new GroupKeyUnwrapError(result.code, result.outcome, result.refusalCode);
          if (result.outcome === 'requested') {
            // A peer is re-wrapping. Short-circuit the next 30s of callers,
            // then let the delivery event through: `wrapped_key_delivered`
            // dedups per group, and the event that triggered this failure has
            // usually already claimed that slot.
            stampPending(groupId, result.code);
            clearWrapDeliveryDedup(groupId);
            // Both stamps above happen either way: a stale verdict is about
            // how long the wait has lasted, not about this attempt, which did
            // succeed in asking the peers.
            //
            // One read, one event: `pendingOrStale` owns the whole reporting
            // decision — `failure` when the wait is still within the bound,
            // the stale verdict (the more informative of the two) past it.
            throw pendingOrStale(groupId, result.code, failure);
          }
          reportGroupKeyFailure(groupId, failure);
          throw failure;
        }
        // 'healed': a stale sender key was refreshed and the retry inside the
        // recovery populated the cache. Fall through to the read below, so the
        // original caller resolves from THIS in-flight promise.
      }
      const resolved = groupKeyCache.get(groupId);
      if (!resolved) {
        throw new Error('Group key not available after processing');
      }
      return resolved;
    } finally {
      inflight.delete(groupId);
    }
  })();

  inflight.set(groupId, promise);
  return promise;
}

/**
 * Invalidate a single cached group key (e.g. on decryption failure due to key rotation).
 * Clears from both in-memory cache AND SQLCipher so the next getOrFetchGroupKey call
 * falls through to the API and fetches the current key from the server.
 */
export function invalidateGroupKey(groupId: string): void {
  const cached = groupKeyCache.get(groupId);
  if (cached) {
    cached.fill(0);
    groupKeyCache.delete(groupId);
  }
  try {
    clearGroupMasterKey(groupId);
  } catch {
    // Database may not be initialized — cache-only invalidation is still useful
  }
}

/**
 * Zero-fill and clear all cached group keys. Must be called on logout.
 */
export function clearGroupKeyCache(): void {
  for (const key of groupKeyCache.values()) {
    key.fill(0);
  }
  groupKeyCache.clear();
}

export function clearContentCryptoInflight(): void {
  inflight.clear();
  pendingGroups.clear();
  // The pending-wrap clock is per account too: a new account on this device
  // must not inherit "this group has been waiting 23 hours" (#937). This is
  // the crypto-side clear; `localWipe` repeats it after MMKV's own `clearAll`.
  clearAllPendingWraps();
  // Cooldowns, demote caps and both session latches belong to the signed-in
  // account, not to the device: an account switch or a key wipe must not
  // inherit the previous session's "already asked twice" or "local key is
  // broken". Deliberately NOT in clearGroupKeyCache, which also runs on
  // ordinary cache invalidation.
  resetGroupKeyRecoveryState();
}

/**
 * Generate a new random 32-byte AES-256 group key.
 * Returns both raw bytes (for immediate crypto use) and base64 string
 * (for sending to the backend in CreateGroupRequest.wrappedGroupKey).
 */
export function generateGroupKey(): { key: Uint8Array; keyBase64: string } {
  const key = new Uint8Array(32);
  (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => void } })
    .crypto.getRandomValues(key);
  return {
    key,
    keyBase64: arrayBufferToBase64(toArrayBuffer(key)),
  };
}

// ---------------------------------------------------------------------------
// Content encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string for storage/transmission.
 *
 * @param plaintext - The content to encrypt (UTF-8 string).
 * @param groupKey  - 32-byte AES-256 group key.
 * @param groupId   - Group identifier used as AAD (binds ciphertext to group).
 * @returns Base64-encoded ciphertext and IV for wire transmission.
 */
export function encryptContent(
  plaintext: string,
  groupKey: Uint8Array,
  groupId: string,
): { ciphertext: string; iv: string } {
  const plaintextBytes = encodeUTF8(plaintext);
  const aadBytes = encodeUTF8(groupId);

  const result: ContentCryptoResult = aesGcmEncrypt(
    toArrayBuffer(plaintextBytes),
    toArrayBuffer(groupKey),
    toArrayBuffer(aadBytes),
  );

  return {
    ciphertext: arrayBufferToBase64(result.ciphertext),
    iv: arrayBufferToBase64(result.iv),
  };
}

/**
 * Decrypt a base64-encoded ciphertext back to a plaintext string.
 *
 * @param ciphertextBase64 - Base64-encoded ciphertext (encrypted_data || auth_tag).
 * @param ivBase64         - Base64-encoded 12-byte IV.
 * @param groupKey         - 32-byte AES-256 group key.
 * @param groupId          - Group identifier used as AAD (must match encryption).
 * @returns The decrypted plaintext string.
 */
export function decryptContent(
  ciphertextBase64: string,
  ivBase64: string,
  groupKey: Uint8Array,
  groupId: string,
): string {
  const ciphertextBytes = base64ToArrayBuffer(ciphertextBase64);
  const ivBytes = base64ToArrayBuffer(ivBase64);
  const aadBytes = encodeUTF8(groupId);

  const plaintext: ArrayBuffer = aesGcmDecrypt(
    ciphertextBytes,
    ivBytes,
    toArrayBuffer(groupKey),
    toArrayBuffer(aadBytes),
  );

  return decodeUTF8(new Uint8Array(plaintext));
}

// ---------------------------------------------------------------------------
// Group name encryption (single-blob wire format, no AAD)
// ---------------------------------------------------------------------------

export function encryptGroupName(name: string, groupKey: Uint8Array): string {
  const plaintextBytes = encodeUTF8(name);
  const emptyAad = new Uint8Array(0);

  const result: ContentCryptoResult = aesGcmEncrypt(
    toArrayBuffer(plaintextBytes),
    toArrayBuffer(groupKey),
    toArrayBuffer(emptyAad),
  );

  const ivBytes = new Uint8Array(result.iv);
  const ctBytes = new Uint8Array(result.ciphertext);
  const combined = new Uint8Array(ivBytes.length + ctBytes.length);
  combined.set(ivBytes, 0);
  combined.set(ctBytes, ivBytes.length);

  return arrayBufferToBase64(toArrayBuffer(combined));
}

export function decryptGroupName(encrypted: string, groupKey: Uint8Array): string {
  const combined = new Uint8Array(base64ToArrayBuffer(encrypted));

  if (combined.length < 12) {
    throw new Error('Encrypted group name too short');
  }

  const ivBytes = combined.slice(0, 12);
  const ctBytes = combined.slice(12);
  const emptyAad = new Uint8Array(0);

  const plaintext: ArrayBuffer = aesGcmDecrypt(
    toArrayBuffer(ctBytes),
    toArrayBuffer(ivBytes),
    toArrayBuffer(groupKey),
    toArrayBuffer(emptyAad),
  );

  return decodeUTF8(new Uint8Array(plaintext));
}
