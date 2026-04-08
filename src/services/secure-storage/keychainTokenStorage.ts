import type { TokenStorage } from '../api/tokenManager';
import { getSecureItem, setSecureItem, removeSecureItem } from './secureStorage';
import { SecureKeys } from './constants';

/**
 * Production-grade TokenStorage backed by the platform Keychain (iOS) or
 * Keystore-backed EncryptedSharedPreferences (Android) via react-native-keychain.
 *
 * Swap this in via tokenManager.configure() during bootstrap.
 */
export class KeychainTokenStorage implements TokenStorage {
  async getAccessToken(): Promise<string | null> {
    return getSecureItem(SecureKeys.ACCESS_TOKEN);
  }

  async setAccessToken(token: string): Promise<void> {
    await setSecureItem(SecureKeys.ACCESS_TOKEN, token);
  }

  async getRefreshToken(): Promise<string | null> {
    return getSecureItem(SecureKeys.REFRESH_TOKEN);
  }

  async setRefreshToken(token: string): Promise<void> {
    await setSecureItem(SecureKeys.REFRESH_TOKEN, token);
  }

  async clearTokens(): Promise<void> {
    await Promise.all([
      removeSecureItem(SecureKeys.ACCESS_TOKEN),
      removeSecureItem(SecureKeys.REFRESH_TOKEN),
    ]);
  }
}
