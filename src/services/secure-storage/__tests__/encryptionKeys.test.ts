/**
 * Tests for encryptionKeys.ts — getOrCreate* functions that provision CSPRNG
 * keys on first launch and return existing ones on subsequent calls.
 */

jest.mock('../secureStorage', () => ({
  getSecureItem: jest.fn(),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  removeSecureItem: jest.fn().mockResolvedValue(undefined),
  clearAll: jest.fn().mockResolvedValue(undefined),
  clearKeychainIfFreshInstall: jest.fn().mockResolvedValue(undefined),
}));

// Mock crypto.getRandomValues to produce deterministic output in tests
const mockFill = jest.fn((array: Uint8Array) => {
  for (let i = 0; i < array.length; i++) {
    array[i] = i % 256;
  }
  return array;
});

Object.defineProperty(globalThis, 'crypto', {
  value: { getRandomValues: mockFill },
  writable: true,
  configurable: true,
});

import { getOrCreateMMKVKey, getOrCreateDatabaseKey } from '../encryptionKeys';
import * as secureStorage from '../secureStorage';
import { SecureKeys } from '../constants';

const mockGetSecureItem = secureStorage.getSecureItem as jest.Mock;
const mockSetSecureItem = secureStorage.setSecureItem as jest.Mock;

describe('getOrCreateMMKVKey', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the existing key when one is already stored', async () => {
    mockGetSecureItem.mockResolvedValueOnce('existing-mmkv-key-hex');
    const key = await getOrCreateMMKVKey();
    expect(key).toBe('existing-mmkv-key-hex');
    expect(mockSetSecureItem).not.toHaveBeenCalled();
  });

  it('generates and stores a new key when none exists', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const key = await getOrCreateMMKVKey();
    expect(mockSetSecureItem).toHaveBeenCalledWith(
      SecureKeys.MMKV_ENCRYPTION_KEY,
      key,
    );
  });

  it('generated key is exactly 64 hex characters (32 bytes)', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const key = await getOrCreateMMKVKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  it('reads from MMKV_ENCRYPTION_KEY', async () => {
    mockGetSecureItem.mockResolvedValueOnce('some-key');
    await getOrCreateMMKVKey();
    expect(mockGetSecureItem).toHaveBeenCalledWith(SecureKeys.MMKV_ENCRYPTION_KEY);
  });
});

describe('getOrCreateDatabaseKey', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the existing key when one is already stored', async () => {
    mockGetSecureItem.mockResolvedValueOnce('existing-db-key-hex');
    const key = await getOrCreateDatabaseKey();
    expect(key).toBe('existing-db-key-hex');
    expect(mockSetSecureItem).not.toHaveBeenCalled();
  });

  it('generates and stores a new key when none exists', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const key = await getOrCreateDatabaseKey();
    expect(mockSetSecureItem).toHaveBeenCalledWith(
      SecureKeys.DATABASE_ENCRYPTION_KEY,
      key,
    );
  });

  it('generated key is exactly 64 hex characters (32 bytes)', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const key = await getOrCreateDatabaseKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  it('reads from DATABASE_ENCRYPTION_KEY', async () => {
    mockGetSecureItem.mockResolvedValueOnce('some-key');
    await getOrCreateDatabaseKey();
    expect(mockGetSecureItem).toHaveBeenCalledWith(SecureKeys.DATABASE_ENCRYPTION_KEY);
  });

  it('uses crypto.getRandomValues to generate key bytes', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    await getOrCreateDatabaseKey();
    expect(mockFill).toHaveBeenCalled();
  });
});
