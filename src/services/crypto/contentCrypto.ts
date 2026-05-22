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

import { aesGcmEncrypt, aesGcmDecrypt } from 'orbital-signal';
import type { ContentCryptoResult } from 'orbital-signal';
import { getGroupKey } from '../api/groups';
import {
  getGroupMasterKey,
  setGroupMasterKey,
  clearGroupMasterKey,
} from '../../database/repositories/conversationRepository';
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from './utils';

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
  try {
    setGroupMasterKey(groupId, keyBytes);
  } catch {
    // Database may not be initialized yet — key is still in memory cache
  }
}

/**
 * Load a group key from SQLCipher (conversations.group_master_key BLOB).
 * Returns null if the conversation doesn't exist or has no key stored.
 */
function loadPersistedGroupKey(groupId: string): Uint8Array | null {
  const key = getGroupMasterKey(groupId);
  if (!key || key.length !== 32) return null;
  return key;
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
 * NOTE: Field renamed to wrappedGroupKey but ECIES seal/open calls are not
 * yet wired into the persist/fetch paths. The Rust primitive (ecies_seal/
 * ecies_open) and backend endpoints (submitWrappedKey, getPendingWraps) are
 * ready — the wrap orchestration is a follow-up task.
 */
export async function getOrFetchGroupKey(groupId: string): Promise<Uint8Array> {
  const cached = groupKeyCache.get(groupId);
  if (cached) return cached;

  try {
    const persisted = loadPersistedGroupKey(groupId);
    if (persisted) {
      groupKeyCache.set(groupId, persisted);
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
        throw new Error('Group key not yet available (pending wrap)');
      }
      const keyBytes = validateAndDecode(response.wrappedGroupKey);
      try {
        setGroupMasterKey(groupId, keyBytes);
      } catch {
        // DB may not be initialized (e.g., Metro Fast Refresh)
      }
      groupKeyCache.set(groupId, keyBytes);
      return keyBytes;
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
