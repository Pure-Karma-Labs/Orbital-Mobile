/**
 * UUID v4 generation using crypto.getRandomValues.
 *
 * Hermes (React Native 0.82+) provides crypto.getRandomValues on globalThis
 * but does NOT expose crypto.randomUUID(). This utility generates RFC 4122
 * compliant v4 UUIDs using the same CSPRNG the codebase already relies on.
 *
 * Matches the pattern used in keyGenerationService.ts and encryptionKeys.ts.
 */

/**
 * Generate a cryptographically random UUID v4 string.
 *
 * @returns A UUID in the form `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
 */
export function generateUUID(): string {
  const cryptoGlobal = (
    globalThis as unknown as {
      crypto: { getRandomValues: (a: Uint8Array) => void };
    }
  ).crypto;

  const bytes = new Uint8Array(16);
  cryptoGlobal.getRandomValues(bytes);

  // Set version 4 (bits 12-15 of time_hi_and_version)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant 1 (bits 6-7 of clock_seq_hi_and_reserved)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
