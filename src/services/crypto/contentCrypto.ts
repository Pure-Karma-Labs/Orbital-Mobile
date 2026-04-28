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
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from './utils';

// ---------------------------------------------------------------------------
// Text encoder/decoder
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Group key cache
// ---------------------------------------------------------------------------

interface CachedGroupKey {
  key: Uint8Array;
  keyId: string;
}

const groupKeyCache = new Map<string, CachedGroupKey>();

/**
 * Get the group key for a groupId, fetching from the API if not cached.
 *
 * The API returns the group key encrypted with the member's public key.
 * TODO: Decrypt the encryptedGroupKey using the user's identity private key.
 * For now this stores the raw base64-decoded value — the actual decryption
 * step will be wired up when the key distribution pipeline is complete.
 */
export async function getOrFetchGroupKey(groupId: string): Promise<Uint8Array> {
  const cached = groupKeyCache.get(groupId);

  // Fetch from API
  const response = await getGroupKey(groupId);

  // Check if cached key is still current (keyId matches)
  if (cached && cached.keyId === response.keyId) {
    return cached.key;
  }

  // TODO: Decrypt encryptedGroupKey with user's identity private key.
  // The server sends a per-member copy encrypted with the member's public key.
  // For now, decode the base64 value directly — this will be replaced with
  // actual asymmetric decryption when the key distribution pipeline is ready.
  const keyBytes = new Uint8Array(base64ToArrayBuffer(response.encryptedGroupKey));

  // Cache the key
  groupKeyCache.set(groupId, { key: keyBytes, keyId: response.keyId });

  return keyBytes;
}

/**
 * Zero-fill and clear all cached group keys. Must be called on logout.
 */
export function clearGroupKeyCache(): void {
  for (const entry of groupKeyCache.values()) {
    // Zero-fill the key material before releasing
    entry.key.fill(0);
  }
  groupKeyCache.clear();
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
export async function encryptContent(
  plaintext: string,
  groupKey: Uint8Array,
  groupId: string,
): Promise<{ ciphertext: string; iv: string }> {
  const plaintextBytes = textEncoder.encode(plaintext);
  const aadBytes = textEncoder.encode(groupId);

  const result: ContentCryptoResult = await aesGcmEncrypt(
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
export async function decryptContent(
  ciphertextBase64: string,
  ivBase64: string,
  groupKey: Uint8Array,
  groupId: string,
): Promise<string> {
  const ciphertextBytes = base64ToArrayBuffer(ciphertextBase64);
  const ivBytes = base64ToArrayBuffer(ivBase64);
  const aadBytes = textEncoder.encode(groupId);

  const plaintext: ArrayBuffer = await aesGcmDecrypt(
    ciphertextBytes,
    ivBytes,
    toArrayBuffer(groupKey),
    toArrayBuffer(aadBytes),
  );

  return textDecoder.decode(plaintext);
}
