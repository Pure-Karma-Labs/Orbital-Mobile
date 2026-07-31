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

import {
  attachmentEncrypt,
  attachmentDecrypt,
  AttachmentEncryptor,
  AttachmentDecryptor,
} from 'orbital-signal';
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
// Streaming encryption
// ---------------------------------------------------------------------------

/**
 * A streaming attachment encryptor that wraps the native AttachmentEncryptor.
 *
 * Accepts plaintext chunks as Uint8Array, returns ciphertext Uint8Array.
 * Call destroy() when done or on error to release native resources.
 */
export interface StreamingAttachmentEncryptor {
  /** Feed a plaintext chunk; returns whole encrypted 16-byte blocks (may be empty). */
  push(chunk: Uint8Array): Uint8Array;
  /** Finalize encryption — returns trailing ciphertext (padding + HMAC) and digest. */
  finalize(): { tail: Uint8Array; digest: Uint8Array };
  /** Release native resources. Idempotent — safe to call multiple times. */
  destroy(): void;
}

/**
 * Create a streaming attachment encryptor backed by the Rust AttachmentEncryptor.
 *
 * The caller MUST call destroy() in a finally block (or after finalize) to release
 * the native FFI object. Failure to do so leaks native memory.
 *
 * @param keys - 64-byte key (32 AES + 32 HMAC), typically from generateAttachmentKeys().
 */
export function createAttachmentEncryptor(keys: Uint8Array): StreamingAttachmentEncryptor {
  const inner = new AttachmentEncryptor(toArrayBuffer(keys));
  let destroyed = false;

  return {
    push(chunk: Uint8Array): Uint8Array {
      const result = inner.push(toArrayBuffer(chunk));
      return new Uint8Array(result);
    },

    finalize(): { tail: Uint8Array; digest: Uint8Array } {
      const result = inner.finalize();
      return {
        tail: new Uint8Array(result.tail),
        digest: new Uint8Array(result.digest),
      };
    },

    destroy(): void {
      if (!destroyed) {
        destroyed = true;
        inner.uniffiDestroy();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming decryption (issue #578)
// ---------------------------------------------------------------------------

/**
 * A streaming attachment decryptor that wraps the native AttachmentDecryptor.
 *
 * **Two passes over the same on-disk ciphertext blob, in this order:**
 * 1. `verifyPush(...)` for every chunk, then `verifyFinalize()` — HMAC and
 *    SHA-256 digest are verified before any plaintext exists.
 * 2. `decryptPush(...)` for every chunk (same blob, chunking may differ), then
 *    `decryptFinalize()` — plaintext streams out.
 *
 * **The boundary is base64 strings, not bytes.** RNFS hands us base64 and takes
 * base64 back, so the chunks pass through untouched and Rust owns the
 * transcode — the Hermes-side loops measured 45-120 ms/MB of JS-thread blocking
 * (issue #578, PR-0 benchmark).
 *
 * **Chunk-alignment contract:** each chunk must be an independently, canonically
 * padded base64 encoding of its own byte range — exactly what
 * `read(path, len, pos, 'base64')` produces. Slicing one big base64 string at
 * arbitrary offsets, or concatenating chunk encodings into one push, fails with
 * the opaque "decryption failed" error and poisons the decryptor.
 *
 * **The phase machine lives in Rust.** Calling out of order throws, and ANY
 * error poisons the decryptor permanently — it can never be resumed.
 *
 * **Caller obligation (TOCTOU):** the plaintext file MUST NOT be promoted before
 * `decryptFinalize()` returns, MUST be unlinked on every failure path, and MUST
 * NEVER be treated as a resumable artifact. A blob modified between the two
 * passes can emit attacker-influenced plaintext before finalize rejects it.
 */
export interface StreamingAttachmentDecryptor {
  /** Pass 1: feed the next base64 ciphertext chunk (whitespace/newlines are fine). */
  verifyPush(chunkBase64: string): void;
  /** Pass 1 completion. Throws (opaquely) if structure, HMAC, or digest fails. */
  verifyFinalize(): void;
  /** Pass 2: feed the next base64 chunk; returns base64 plaintext (often empty). */
  decryptPush(chunkBase64: string): string;
  /** Pass 2 completion: returns the base64 plaintext tail. Throws on divergence. */
  decryptFinalize(): string;
  /** Release native resources. Idempotent — safe to call multiple times. */
  destroy(): void;
}

/**
 * Create a streaming attachment decryptor backed by the Rust AttachmentDecryptor.
 *
 * The caller MUST call destroy() in a finally block to release the native FFI
 * object. Failure to do so leaks native memory.
 *
 * @param keys           - 64-byte key (32 AES + 32 HMAC) from the media metadata envelope.
 * @param expectedDigest - SHA-256 digest of the ciphertext blob. Bound at
 *                         construction so the digest check cannot be skipped.
 */
export function createAttachmentDecryptor(
  keys: Uint8Array,
  expectedDigest: Uint8Array,
): StreamingAttachmentDecryptor {
  const inner = new AttachmentDecryptor(
    toArrayBuffer(keys),
    toArrayBuffer(expectedDigest),
  );
  let destroyed = false;

  return {
    verifyPush(chunkBase64: string): void {
      inner.verifyPush(chunkBase64);
    },

    verifyFinalize(): void {
      inner.verifyFinalize();
    },

    decryptPush(chunkBase64: string): string {
      return inner.decryptPush(chunkBase64);
    },

    decryptFinalize(): string {
      return inner.decryptFinalize();
    },

    destroy(): void {
      if (!destroyed) {
        destroyed = true;
        inner.uniffiDestroy();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// One-shot encryption
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
