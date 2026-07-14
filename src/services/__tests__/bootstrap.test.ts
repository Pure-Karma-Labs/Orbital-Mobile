/**
 * Tests for bootstrap.ts — specifically the handleTokensCleared export
 * and its interaction with recoveryState.
 *
 * Strategy: heavy-mock every non-trivial import of bootstrap.ts.
 * Deliberately REAL (not mocked): recoveryState and tokenManager — they're
 * under test.
 */

// ---------------------------------------------------------------------------
// Module mocks — MUST be before imports
// ---------------------------------------------------------------------------

jest.mock('../secure-storage', () => ({
  clearKeychainIfFreshInstall: jest.fn().mockResolvedValue(undefined),
  getOrCreateMMKVKey: jest.fn().mockResolvedValue('mock-mmkv-key'),
  getOrCreateDatabaseKey: jest.fn().mockResolvedValue('mock-db-key'),
  KeychainTokenStorage: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn(),
    setAccessToken: jest.fn(),
    getRefreshToken: jest.fn(),
    setRefreshToken: jest.fn(),
    clearTokens: jest.fn(),
  })),
}));

jest.mock('../../stores/middleware/persistence', () => ({
  initMMKV: jest.fn(),
}));

jest.mock('../../database', () => ({
  initDatabase: jest.fn(),
}));

jest.mock('../../database/migrations', () => ({
  runMigrations: jest.fn(),
}));

jest.mock('../crypto/keyGenerationService', () => ({
  initIdentityKeyCache: jest.fn().mockResolvedValue(undefined),
}));

// Mock lazy imports that bootstrap() calls via import()
jest.mock('../verificationService', () => ({
  syncVerifiedStatusToStore: jest.fn(),
}));

jest.mock('../mediaUploadService', () => ({
  cleanupOrphanedChunks: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../mediaDownloadService', () => ({
  cleanupOrphanedMedia: jest.fn().mockResolvedValue(undefined),
}));

const mockClearAuth = jest.fn();
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      clearAuth: mockClearAuth,
    })),
    persist: {
      rehydrate: jest.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handleTokensCleared } from '../../bootstrap';
import { isRecoveryInitiator, setRecoveryInitiator } from '../recoveryState';
import { tokenManager } from '../api/tokenManager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTokensCleared', () => {
  afterEach(() => {
    // Always reset the recovery flag to prevent cross-test contamination.
    setRecoveryInitiator(false);
    jest.clearAllMocks();
  });

  it('pollution guard: isRecoveryInitiator is false before each test', () => {
    expect(isRecoveryInitiator()).toBe(false);
  });

  it('calls clearAuth when recovery flag is false', () => {
    handleTokensCleared();
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  it('does NOT call clearAuth when recovery flag is true', () => {
    setRecoveryInitiator(true);
    handleTokensCleared();
    expect(mockClearAuth).not.toHaveBeenCalled();
  });

  it('calls clearAuth again after recovery flag is reset to false', () => {
    setRecoveryInitiator(true);
    handleTokensCleared();
    expect(mockClearAuth).not.toHaveBeenCalled();

    setRecoveryInitiator(false);
    handleTokensCleared();
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });
});

describe('tokenManager.onTokensCleared integration', () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    setRecoveryInitiator(false);
    // Unsubscribe any listener registered during the test to prevent
    // cross-contamination across the jest worker (real singleton).
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    jest.clearAllMocks();
  });

  it('listener registered via onTokensCleared fires handleTokensCleared', async () => {
    unsubscribe = tokenManager.onTokensCleared(handleTokensCleared);
    await tokenManager.clearTokens();
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  it('listener suppressed during recovery', async () => {
    unsubscribe = tokenManager.onTokensCleared(handleTokensCleared);
    setRecoveryInitiator(true);
    await tokenManager.clearTokens();
    expect(mockClearAuth).not.toHaveBeenCalled();
  });
});
