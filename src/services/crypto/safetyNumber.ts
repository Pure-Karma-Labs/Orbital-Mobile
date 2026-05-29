/**
 * Safety number computation for identity verification.
 *
 * Produces a 30-digit fingerprint from two (userId, publicKey) pairs.
 * The result is symmetric: swapping local/remote produces the same output.
 *
 * Uses a single SHA-256 hash via the Rust sha256Hash export.
 * This is a documented deviation from Signal's iterated SHA-512.
 */

import { sha256Hash } from '../../../packages/orbital-signal/src/generated/orbital_signal';

/**
 * Compute a safety number from two identity key pairs.
 *
 * @param localUserId - Current user's service ID
 * @param localPublicKey - Current user's identity public key (33 bytes)
 * @param remoteUserId - Remote user's service ID
 * @param remotePublicKey - Remote user's identity public key (33 bytes)
 * @returns 30-digit string formatted as 6 groups of 5 digits, space-separated
 */
export function computeSafetyNumber(
  localUserId: string,
  localPublicKey: Uint8Array,
  remoteUserId: string,
  remotePublicKey: Uint8Array,
): string {
  // Canonical ordering by userId using < operator (byte/codepoint comparison)
  let firstKey: Uint8Array;
  let secondKey: Uint8Array;
  let firstId: string;
  let secondId: string;

  if (localUserId < remoteUserId) {
    firstKey = localPublicKey;
    secondKey = remotePublicKey;
    firstId = localUserId;
    secondId = remoteUserId;
  } else {
    firstKey = remotePublicKey;
    secondKey = localPublicKey;
    firstId = remoteUserId;
    secondId = localUserId;
  }

  // Encode userIds as UTF-8
  const encoder = new TextEncoder();
  const firstIdBytes = encoder.encode(firstId);
  const secondIdBytes = encoder.encode(secondId);

  // Concatenate: sortedKey1 || sortedKey2 || sortedId1_utf8 || sortedId2_utf8
  const totalLen = firstKey.length + secondKey.length + firstIdBytes.length + secondIdBytes.length;
  const input = new Uint8Array(totalLen);
  let offset = 0;
  input.set(firstKey, offset); offset += firstKey.length;
  input.set(secondKey, offset); offset += secondKey.length;
  input.set(firstIdBytes, offset); offset += firstIdBytes.length;
  input.set(secondIdBytes, offset);

  // SHA-256 via Rust
  const hashBuffer = sha256Hash(input.buffer as ArrayBuffer);
  const hashBytes = new Uint8Array(hashBuffer);

  // Convert first 30 bytes to 6 groups of 5 digits
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const startByte = i * 5;
    // Read 5 bytes, interpret as a number mod 100000
    let value = 0;
    for (let j = 0; j < 5; j++) {
      value = value * 256 + hashBytes[startByte + j];
    }
    // 5 bytes = 40 bits = max ~1.1 trillion, mod 100000 for 5 digits
    groups.push(String(value % 100000).padStart(5, '0'));
  }

  return groups.join(' ');
}
