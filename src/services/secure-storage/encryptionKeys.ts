/**
 * Encryption key provisioning for MMKV and SQLCipher.
 *
 * Keys are CSPRNG output — no KDF needed. MMKV uses AES-CFB-128 internally
 * (128 bits effective). SQLCipher should use PRAGMA key = "x'<hex>'" to use
 * raw bytes.
 */

import { SecureKeys } from './constants';
import { getSecureItem, setSecureItem } from './secureStorage';

/**
 * Returns the existing MMKV encryption key from Keychain, or generates and
 * stores a new 32-byte (256-bit) CSPRNG key on first call.
 */
export async function getOrCreateMMKVKey(): Promise<string> {
  const existing = await getSecureItem(SecureKeys.MMKV_ENCRYPTION_KEY);
  if (existing !== null) return existing;
  const key = generateRandomHexKey(32);
  await setSecureItem(SecureKeys.MMKV_ENCRYPTION_KEY, key);
  return key;
}

/**
 * Returns the existing SQLCipher database encryption key from Keychain, or
 * generates and stores a new 32-byte (256-bit) CSPRNG key on first call.
 */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const existing = await getSecureItem(SecureKeys.DATABASE_ENCRYPTION_KEY);
  if (existing !== null) return existing;
  const key = generateRandomHexKey(32);
  await setSecureItem(SecureKeys.DATABASE_ENCRYPTION_KEY, key);
  return key;
}

function generateRandomHexKey(bytes: number): string {
  const array = new Uint8Array(bytes);
  // crypto.getRandomValues is available on Hermes (RN 0.82+) via globalThis.
  // The TypeScript lib config omits 'dom', so we access it through globalThis cast to unknown.
  const cryptoGlobal = (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => void } }).crypto;
  cryptoGlobal.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}
