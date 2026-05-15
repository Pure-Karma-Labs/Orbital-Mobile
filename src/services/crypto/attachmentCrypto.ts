/**
 * attachmentCrypto — AES-256-CBC + HMAC-SHA256 attachment encryption/decryption.
 *
 * Wraps the Rust `attachment_encrypt` / `attachment_decrypt` functions exposed via uniffi.
 * The Rust layer handles the actual cryptographic operations; this module provides
 * key generation and TypeScript-friendly conversions between Uint8Array and ArrayBuffer.
 *
 * **Wire format (Signal Protocol attachments):**
 * - 64-byte key: first 32 = AES-256 key, last 32 = HMAC-SHA256 key
 * - Ciphertext: IV (16) || encrypted_data (PKCS7 padded) || HMAC-SHA256 (32)
 * - Digest: SHA-256 of the entire ciphertext blob
 * - Plaintext hash: SHA-256 of original plaintext (local integrity only — never sent to server)
 *
 * SECURITY: HMAC verification precedes CBC decryption in the Rust layer (prevents padding oracle).
 * SECURITY: plaintext_hash must never be sent to the server — content fingerprint breaks zero-knowledge.
 */

import { attachmentEncrypt, attachmentDecrypt } from 'orbital-signal';
import type { AttachmentCryptoResult } from 'orbital-signal';
import { arrayBufferToBase64, toArrayBuffer } from './utils';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 64-byte attachment key (32 AES + 32 HMAC).
 *
 * Uses crypto.getRandomValues which is polyfilled in React Native
 * via react-native-get-random-values (imported in index.js).
 */
export function generateAttachmentKeys(): {
  keys: Uint8Array;
  keysBase64: string;
} {
  const keys = new Uint8Array(64);
  (
    globalThis as unknown as {
      crypto: { getRandomValues: (a: Uint8Array) => void };
    }
  ).crypto.getRandomValues(keys);
  return {
    keys,
    keysBase64: arrayBufferToBase64(toArrayBuffer(keys)),
  };
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export interface EncryptAttachmentResult {
  /** IV || encrypted_data || HMAC — ready for upload */
  ciphertext: Uint8Array;
  /** SHA-256 of the ciphertext blob — for integrity verification on download */
  digest: Uint8Array;
}

/**
 * Encrypt an attachment (photo, file, etc.) using Signal Protocol format.
 *
 * @param plaintext - Raw file bytes to encrypt.
 * @param keys      - 64-byte key (32 AES + 32 HMAC), typically from generateAttachmentKeys().
 * @returns Encrypted ciphertext and digest.
 */
export function encryptAttachment(
  plaintext: Uint8Array,
  keys: Uint8Array,
): EncryptAttachmentResult {
  const result: AttachmentCryptoResult = attachmentEncrypt(
    toArrayBuffer(plaintext),
    toArrayBuffer(keys),
  );

  return {
    ciphertext: new Uint8Array(result.ciphertext),
    digest: new Uint8Array(result.digest),
  };
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt an attachment downloaded from the server.
 *
 * @param ciphertext     - IV || encrypted_data || HMAC blob from the server.
 * @param keys           - 64-byte key (32 AES + 32 HMAC) that was used for encryption.
 * @param expectedDigest - SHA-256 digest of the ciphertext blob (from MediaMetadata).
 * @returns Decrypted file bytes.
 * @throws Error if HMAC verification, digest check, or decryption fails (opaque error).
 */
export function decryptAttachment(
  ciphertext: Uint8Array,
  keys: Uint8Array,
  expectedDigest: Uint8Array,
): Uint8Array {
  const plaintext: ArrayBuffer = attachmentDecrypt(
    toArrayBuffer(ciphertext),
    toArrayBuffer(keys),
    toArrayBuffer(expectedDigest),
  );

  return new Uint8Array(plaintext);
}
