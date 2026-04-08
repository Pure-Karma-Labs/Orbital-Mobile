/**
 * Tests for the pluggable token manager.
 */

import { tokenManager, InMemoryTokenStorage } from '../tokenManager';
import type { TokenStorage } from '../tokenManager';

// Reset between tests by creating a fresh instance via configure()
// (tokenManager is a singleton so we reconfigure it each test)

beforeEach(async () => {
  // Reset to a fresh InMemoryTokenStorage before each test
  tokenManager.configure(new InMemoryTokenStorage());
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('returns null access token before any tokens are set', async () => {
    expect(await tokenManager.getAccessToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// set / get / clear cycle
// ---------------------------------------------------------------------------

describe('set, get, clear cycle', () => {
  it('stores and retrieves access token', async () => {
    await tokenManager.setTokens('access-abc');
    expect(await tokenManager.getAccessToken()).toBe('access-abc');
  });

  it('clearTokens resets access token to null', async () => {
    await tokenManager.setTokens('access-abc');
    await tokenManager.clearTokens();
    expect(await tokenManager.getAccessToken()).toBeNull();
  });

  it('concurrent clearTokens calls are idempotent', async () => {
    await tokenManager.setTokens('access-abc');
    await Promise.all([
      tokenManager.clearTokens(),
      tokenManager.clearTokens(),
      tokenManager.clearTokens(),
    ]);
    expect(await tokenManager.getAccessToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// configure() swaps storage implementation
// ---------------------------------------------------------------------------

describe('configure()', () => {
  it('marks tokenManager as configured after configure() call', () => {
    const storage = new InMemoryTokenStorage();
    tokenManager.configure(storage);
    expect(tokenManager.isConfigured()).toBe(true);
  });

  it('swaps to the provided storage implementation', async () => {
    const customStorage: TokenStorage = {
      getAccessToken: jest.fn().mockResolvedValue('custom-token'),
      setAccessToken: jest.fn().mockResolvedValue(undefined),
      getRefreshToken: jest.fn().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearTokens: jest.fn().mockResolvedValue(undefined),
    };

    tokenManager.configure(customStorage);
    const token = await tokenManager.getAccessToken();

    expect(token).toBe('custom-token');
    expect(customStorage.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('delegates setTokens(access, refresh) to storage', async () => {
    const customStorage: TokenStorage = {
      getAccessToken: jest.fn().mockResolvedValue(null),
      setAccessToken: jest.fn().mockResolvedValue(undefined),
      getRefreshToken: jest.fn().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearTokens: jest.fn().mockResolvedValue(undefined),
    };

    tokenManager.configure(customStorage);
    await tokenManager.setTokens('access-tok', 'refresh-tok');

    expect(customStorage.setAccessToken).toHaveBeenCalledWith('access-tok');
    expect(customStorage.setRefreshToken).toHaveBeenCalledWith('refresh-tok');
  });

  it('does not call setRefreshToken when refresh token is undefined', async () => {
    const customStorage: TokenStorage = {
      getAccessToken: jest.fn().mockResolvedValue(null),
      setAccessToken: jest.fn().mockResolvedValue(undefined),
      getRefreshToken: jest.fn().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearTokens: jest.fn().mockResolvedValue(undefined),
    };

    tokenManager.configure(customStorage);
    await tokenManager.setTokens('access-tok');

    expect(customStorage.setAccessToken).toHaveBeenCalledWith('access-tok');
    expect(customStorage.setRefreshToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// InMemoryTokenStorage direct tests
// ---------------------------------------------------------------------------

describe('InMemoryTokenStorage', () => {
  it('stores and retrieves access and refresh tokens independently', async () => {
    const storage = new InMemoryTokenStorage();
    await storage.setAccessToken('a-tok');
    await storage.setRefreshToken('r-tok');
    expect(await storage.getAccessToken()).toBe('a-tok');
    expect(await storage.getRefreshToken()).toBe('r-tok');
  });

  it('clearTokens wipes both tokens', async () => {
    const storage = new InMemoryTokenStorage();
    await storage.setAccessToken('a-tok');
    await storage.setRefreshToken('r-tok');
    await storage.clearTokens();
    expect(await storage.getAccessToken()).toBeNull();
    expect(await storage.getRefreshToken()).toBeNull();
  });
});
