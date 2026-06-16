/**
 * Tests for secureStorage.ts — wraps react-native-keychain with a typed API.
 */

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_ANY: 'BiometryAny' },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

import * as Keychain from 'react-native-keychain';
import {
  setSecureItem,
  getSecureItem,
  removeSecureItem,
  clearAll,
  clearKeychainIfFreshInstall,
} from '../secureStorage';
import { SecureKeys, KEYCHAIN_USERNAME } from '../constants';
import { Platform } from 'react-native';

// STORAGE_TYPE enum value used in mock return objects
const MOCK_STORAGE_TYPE = 'keychain' as unknown as Keychain.STORAGE_TYPE;

const mockKeychain = Keychain as jest.Mocked<typeof Keychain>;

describe('setSecureItem', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls setGenericPassword with username, value, and service option', async () => {
    await setSecureItem('my.service.key', 'secret-value');
    expect(mockKeychain.setGenericPassword).toHaveBeenCalledWith(
      KEYCHAIN_USERNAME,
      'secret-value',
      expect.objectContaining({ service: 'my.service.key' }),
    );
  });

  it('passes AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY accessibility level', async () => {
    await setSecureItem('my.service.key', 'value');
    expect(mockKeychain.setGenericPassword).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
    );
  });
});

describe('getSecureItem', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the password when Keychain has an entry', async () => {
    mockKeychain.getGenericPassword.mockResolvedValueOnce({
      service: 'my.service.key',
      username: KEYCHAIN_USERNAME,
      password: 'stored-secret',
      storage: MOCK_STORAGE_TYPE,
    });
    const result = await getSecureItem('my.service.key');
    expect(result).toBe('stored-secret');
  });

  it('returns null when Keychain returns false (no entry)', async () => {
    mockKeychain.getGenericPassword.mockResolvedValueOnce(false);
    const result = await getSecureItem('missing.key');
    expect(result).toBeNull();
  });

  it('passes the service option to getGenericPassword', async () => {
    await getSecureItem('com.orbital.mobile.jwt-access-token');
    expect(mockKeychain.getGenericPassword).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'com.orbital.mobile.jwt-access-token' }),
    );
  });
});

describe('removeSecureItem', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls resetGenericPassword with the service option', async () => {
    await removeSecureItem('my.service.key');
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'my.service.key' }),
    );
  });
});

describe('clearAll', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls resetGenericPassword for every SecureKeys entry', async () => {
    await clearAll();
    const allKeys = Object.values(SecureKeys);
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledTimes(allKeys.length);
    for (const key of allKeys) {
      expect(mockKeychain.resetGenericPassword).toHaveBeenCalledWith(
        expect.objectContaining({ service: key }),
      );
    }
  });
});

describe('set/get/remove cycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores and retrieves a value', async () => {
    const storedValue = 'my-jwt-token';
    // Simulate storage returning the value we set
    mockKeychain.getGenericPassword.mockResolvedValueOnce({
      service: SecureKeys.ACCESS_TOKEN,
      username: KEYCHAIN_USERNAME,
      password: storedValue,
      storage: MOCK_STORAGE_TYPE,
    });

    await setSecureItem(SecureKeys.ACCESS_TOKEN, storedValue);
    const retrieved = await getSecureItem(SecureKeys.ACCESS_TOKEN);
    expect(retrieved).toBe(storedValue);
  });

  it('returns null after removing an item', async () => {
    mockKeychain.getGenericPassword.mockResolvedValueOnce(false);
    await removeSecureItem(SecureKeys.ACCESS_TOKEN);
    const result = await getSecureItem(SecureKeys.ACCESS_TOKEN);
    expect(result).toBeNull();
  });
});

describe('clearKeychainIfFreshInstall', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing on Android', async () => {
    (Platform as { OS: string }).OS = 'android';
    await clearKeychainIfFreshInstall();
    expect(mockKeychain.resetGenericPassword).not.toHaveBeenCalled();
    expect(mockKeychain.setGenericPassword).not.toHaveBeenCalled();
  });

  it('clears keychain and sets sentinel on iOS fresh install', async () => {
    (Platform as { OS: string }).OS = 'ios';
    // Sentinel not present — fresh install
    mockKeychain.getGenericPassword.mockResolvedValueOnce(false);
    await clearKeychainIfFreshInstall();
    const allKeys = Object.values(SecureKeys);
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledTimes(allKeys.length);
    expect(mockKeychain.setGenericPassword).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      expect.objectContaining({ service: SecureKeys.INSTALLED_SENTINEL }),
    );
  });

  it('does not clear keychain on iOS when already installed', async () => {
    (Platform as { OS: string }).OS = 'ios';
    // Sentinel present — not a fresh install
    mockKeychain.getGenericPassword.mockResolvedValueOnce({
      service: SecureKeys.INSTALLED_SENTINEL,
      username: KEYCHAIN_USERNAME,
      password: '1',
      storage: 'keychain' as unknown as Keychain.STORAGE_TYPE,
    });
    await clearKeychainIfFreshInstall();
    expect(mockKeychain.resetGenericPassword).not.toHaveBeenCalled();
  });
});
