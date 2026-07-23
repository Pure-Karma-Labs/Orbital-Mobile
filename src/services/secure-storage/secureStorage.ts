import * as Keychain from 'react-native-keychain';
import { Platform } from 'react-native';
import { SecureKeys, KEYCHAIN_USERNAME } from './constants';

/**
 * Stores a secure string value under the given key.
 * Each key is stored as a separate Keychain service entry.
 */
export async function setSecureItem(
  key: string,
  value: string,
  _options?: { biometricProtected?: boolean },
): Promise<void> {
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME, value, {
    service: key,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieves the secure string value for the given key.
 * Returns null if no entry exists.
 */
export async function getSecureItem(key: string): Promise<string | null> {
  const result = await Keychain.getGenericPassword({ service: key });
  if (result === false) {
    return null;
  }
  return result.password;
}

/**
 * Removes the secure entry for the given key.
 */
export async function removeSecureItem(key: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: key });
}

/**
 * Removes all known Orbital secure storage entries.
 * Used on fresh install detection and logout.
 */
export async function clearAll(): Promise<void> {
  await Promise.all(
    Object.values(SecureKeys).map((key) => removeSecureItem(key)),
  );
}

/**
 * Fresh-install detection via Keychain sentinel.
 *
 * On iOS, Keychain entries survive app uninstall (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY).
 * This is now an INTENTIONAL identity-continuity feature:
 *
 * - IDENTITY_KEY_PRIVATE surviving means attemptKeychainIdentityRestore() can
 *   seamlessly restore the user's cryptographic identity after reinstall.
 * - DATABASE_ENCRYPTION_KEY / MMKV_ENCRYPTION_KEY surviving just encrypt fresh
 *   files (the SQLCipher DB itself is deleted on uninstall).
 * - ACCESS_TOKEN surviving enables restoreSession() to skip the login screen,
 *   completing the ideal reinstall UX (Keychain possession = device possession;
 *   AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY ensures the device is unlocked).
 *
 * This function checks a sentinel key and clears all Keychain entries ONLY on
 * a true fresh install (no sentinel). After the first run it sets the sentinel,
 * so subsequent launches (and reinstalls preserving Keychain) skip the clear.
 *
 * Using Keychain (rather than NSUserDefaults/Settings) for the sentinel
 * prevents a Metro Fast Refresh race where Settings.set hadn't persisted
 * yet on the second JS reload, causing a spurious double-wipe of the DB key.
 *
 * No-op on Android (Keystore entries are tied to the app installation).
 */
export async function clearKeychainIfFreshInstall(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const installed = await getSecureItem(SecureKeys.INSTALLED_SENTINEL);
  if (!installed) {
    await clearAll();
    await setSecureItem(SecureKeys.INSTALLED_SENTINEL, '1');
  }
}
