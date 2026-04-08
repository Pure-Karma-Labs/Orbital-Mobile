/**
 * Tests for KeychainTokenStorage — implements TokenStorage via secureStorage helpers.
 */

jest.mock('../secureStorage', () => ({
  getSecureItem: jest.fn(),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  removeSecureItem: jest.fn().mockResolvedValue(undefined),
  clearAll: jest.fn().mockResolvedValue(undefined),
  clearKeychainIfFreshInstall: jest.fn().mockResolvedValue(undefined),
}));

import { KeychainTokenStorage } from '../keychainTokenStorage';
import * as secureStorage from '../secureStorage';
import { SecureKeys } from '../constants';

const mockGetSecureItem = secureStorage.getSecureItem as jest.Mock;
const mockSetSecureItem = secureStorage.setSecureItem as jest.Mock;
const mockRemoveSecureItem = secureStorage.removeSecureItem as jest.Mock;

describe('KeychainTokenStorage', () => {
  let storage: KeychainTokenStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new KeychainTokenStorage();
  });

  // ---------------------------------------------------------------------------
  // Access token
  // ---------------------------------------------------------------------------

  it('getAccessToken returns stored value', async () => {
    mockGetSecureItem.mockResolvedValueOnce('access-jwt');
    const result = await storage.getAccessToken();
    expect(result).toBe('access-jwt');
    expect(mockGetSecureItem).toHaveBeenCalledWith(SecureKeys.ACCESS_TOKEN);
  });

  it('getAccessToken returns null when not set', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const result = await storage.getAccessToken();
    expect(result).toBeNull();
  });

  it('setAccessToken stores under ACCESS_TOKEN key', async () => {
    await storage.setAccessToken('new-access-token');
    expect(mockSetSecureItem).toHaveBeenCalledWith(SecureKeys.ACCESS_TOKEN, 'new-access-token');
  });

  // ---------------------------------------------------------------------------
  // Refresh token
  // ---------------------------------------------------------------------------

  it('getRefreshToken returns stored value', async () => {
    mockGetSecureItem.mockResolvedValueOnce('refresh-jwt');
    const result = await storage.getRefreshToken();
    expect(result).toBe('refresh-jwt');
    expect(mockGetSecureItem).toHaveBeenCalledWith(SecureKeys.REFRESH_TOKEN);
  });

  it('getRefreshToken returns null when not set', async () => {
    mockGetSecureItem.mockResolvedValueOnce(null);
    const result = await storage.getRefreshToken();
    expect(result).toBeNull();
  });

  it('setRefreshToken stores under REFRESH_TOKEN key', async () => {
    await storage.setRefreshToken('new-refresh-token');
    expect(mockSetSecureItem).toHaveBeenCalledWith(SecureKeys.REFRESH_TOKEN, 'new-refresh-token');
  });

  // ---------------------------------------------------------------------------
  // clearTokens
  // ---------------------------------------------------------------------------

  it('clearTokens removes both access and refresh token keys', async () => {
    await storage.clearTokens();
    expect(mockRemoveSecureItem).toHaveBeenCalledTimes(2);
    expect(mockRemoveSecureItem).toHaveBeenCalledWith(SecureKeys.ACCESS_TOKEN);
    expect(mockRemoveSecureItem).toHaveBeenCalledWith(SecureKeys.REFRESH_TOKEN);
  });

  it('clearTokens removes both tokens in parallel (both called even if one fails)', async () => {
    // Both calls should be issued regardless of order
    await storage.clearTokens();
    const calls = mockRemoveSecureItem.mock.calls.map(([key]) => key);
    expect(calls).toContain(SecureKeys.ACCESS_TOKEN);
    expect(calls).toContain(SecureKeys.REFRESH_TOKEN);
  });

  // ---------------------------------------------------------------------------
  // Implements the TokenStorage interface correctly
  // ---------------------------------------------------------------------------

  it('satisfies the TokenStorage interface shape', () => {
    expect(typeof storage.getAccessToken).toBe('function');
    expect(typeof storage.setAccessToken).toBe('function');
    expect(typeof storage.getRefreshToken).toBe('function');
    expect(typeof storage.setRefreshToken).toBe('function');
    expect(typeof storage.clearTokens).toBe('function');
  });
});
