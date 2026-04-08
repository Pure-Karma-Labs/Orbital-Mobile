import * as Keychain from 'react-native-keychain';
import { Platform, Settings } from 'react-native';
import { SecureKeys, KEYCHAIN_USERNAME } from './constants';

const INSTALLED_KEY = '@orbital:installed';

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
 * On iOS, Keychain survives app uninstall. This function detects a fresh
 * install via NSUserDefaults (Settings) — which DOES get wiped on uninstall —
 * and clears stale Keychain data from a previous installation.
 *
 * No-op on Android (Keystore entries are tied to the app installation).
 */
export async function clearKeychainIfFreshInstall(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const installed = Settings.get(INSTALLED_KEY);
  if (!installed) {
    await clearAll();
    Settings.set({ [INSTALLED_KEY]: '1' });
  }
}
