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

// @sentry/react-native ships ESM that jest does not transform; bootstrap now
// reaches it transitively via notificationSettingsSync (#678).
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

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

// MMKV / database mocks are STATEFUL: bootstrap's idempotency guards read
// is*Initialized(), so the mocks have to behave like the real modules
// (init flips the flag) for the retry-path tests to mean anything.
const mockStorageState = { mmkv: false, database: false };
const mockInitMMKV = jest.fn((..._args: unknown[]) => {
  mockStorageState.mmkv = true;
});
const mockInitDatabase = jest.fn((..._args: unknown[]) => {
  mockStorageState.database = true;
});

jest.mock('../../stores/middleware/persistence', () => ({
  initMMKV: (...args: unknown[]) => mockInitMMKV(...args),
  isMMKVInitialized: () => mockStorageState.mmkv,
}));

jest.mock('../../database', () => ({
  initDatabase: (...args: unknown[]) => mockInitDatabase(...args),
  isDatabaseInitialized: () => mockStorageState.database,
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

const mockRegisterForegroundDrain = jest.fn();
const mockSchedulePendingMediaDrain = jest.fn();
jest.mock('../mediaPrefetchService', () => ({
  registerForegroundDrain: (...args: unknown[]) => mockRegisterForegroundDrain(...args),
  schedulePendingMediaDrain: (...args: unknown[]) => mockSchedulePendingMediaDrain(...args),
}));

const mockRegisterForegroundConfirmDrain = jest.fn();
const mockScheduleArchiveConfirmDrain = jest.fn();
jest.mock('../mediaArchiveConfirmService', () => ({
  registerForegroundConfirmDrain: (...args: unknown[]) => mockRegisterForegroundConfirmDrain(...args),
  scheduleArchiveConfirmDrain: (...args: unknown[]) => mockScheduleArchiveConfirmDrain(...args),
}));

const mockRegisterForegroundNotificationSettingsSync = jest.fn();
jest.mock('../notificationSettingsSync', () => ({
  registerForegroundNotificationSettingsSync: (...args: unknown[]) =>
    mockRegisterForegroundNotificationSettingsSync(...args),
}));

const mockInstallGroupKeyFailureReporter = jest.fn();
jest.mock('../groupKeyTelemetry', () => ({
  installGroupKeyFailureReporter: (...args: unknown[]) =>
    mockInstallGroupKeyFailureReporter(...args),
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

import { bootstrap, handleTokensCleared, resetBootstrapForTesting } from '../../bootstrap';
import { isRecoveryInitiator, setRecoveryInitiator } from '../recoveryState';
import { tokenManager } from '../api/tokenManager';
import {
  clearKeychainIfFreshInstall,
  getOrCreateMMKVKey,
  getOrCreateDatabaseKey,
} from '../secure-storage';

// clearKeychainIfFreshInstall is the only unguarded step, so its call count is
// the direct observable for "the whole sequence ran again".
const mockClearKeychainIfFreshInstall = jest.mocked(clearKeychainIfFreshInstall);
const mockGetOrCreateMMKVKey = jest.mocked(getOrCreateMMKVKey);
const mockGetOrCreateDatabaseKey = jest.mocked(getOrCreateDatabaseKey);

// bootstrap() caches its promise and guards each step against module-level
// state, so every test starts from a clean process-like slate.
beforeEach(() => {
  resetBootstrapForTesting();
  mockStorageState.mmkv = false;
  mockStorageState.database = false;
});

/** Flush the microtasks queued by bootstrap's lazy `import().then()` tail. */
async function flushLazyImports(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

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

describe('bootstrap() wiring', () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    setRecoveryInitiator(false);
    // bootstrap() registers on the real tokenManager singleton — unhook every
    // registration captured via the spy to prevent cross-test contamination.
    while (unsubscribes.length) {
      unsubscribes.pop()!();
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('bootstrap() registers handleTokensCleared so clearTokens triggers clearAuth', async () => {
    const spy = jest.spyOn(tokenManager, 'onTokensCleared');

    await bootstrap();

    expect(spy).toHaveBeenCalledWith(handleTokensCleared);
    for (const result of spy.mock.results) {
      unsubscribes.push(result.value as () => void);
    }

    await tokenManager.clearTokens();
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  it('bootstrap() registers foreground prefetch drain and schedules initial drain', async () => {
    await bootstrap();

    await flushLazyImports();

    expect(mockRegisterForegroundDrain).toHaveBeenCalledTimes(1);
    expect(mockSchedulePendingMediaDrain).toHaveBeenCalledTimes(1);
  });

  it('bootstrap() registers foreground archive-confirm drain and schedules initial drain', async () => {
    await bootstrap();

    await flushLazyImports();

    expect(mockRegisterForegroundConfirmDrain).toHaveBeenCalledTimes(1);
    expect(mockScheduleArchiveConfirmDrain).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #914: an Android activity re-create remounts App, which calls bootstrap()
// again. A second unguarded run threw `MMKV already initialized`.
// ---------------------------------------------------------------------------

describe('bootstrap() idempotency (#914)', () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    setRecoveryInitiator(false);
    while (unsubscribes.length) {
      unsubscribes.pop()!();
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  /** Capture every listener bootstrap registered so it can be unhooked. */
  function trackRegistrations(spy: jest.SpyInstance): void {
    for (const result of spy.mock.results) {
      if (typeof result.value === 'function') {
        unsubscribes.push(result.value as () => void);
      }
    }
  }

  it('runs the sequence once for two concurrent calls', async () => {
    const spy = jest.spyOn(tokenManager, 'onTokensCleared');

    await Promise.all([bootstrap(), bootstrap()]);
    trackRegistrations(spy);
    await flushLazyImports();

    expect(mockClearKeychainIfFreshInstall).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMMKVKey).toHaveBeenCalledTimes(1);
    expect(mockInitMMKV).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateDatabaseKey).toHaveBeenCalledTimes(1);
    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockRegisterForegroundDrain).toHaveBeenCalledTimes(1);
  });

  it('does not re-run after it has already resolved', async () => {
    const spy = jest.spyOn(tokenManager, 'onTokensCleared');

    await bootstrap();
    await bootstrap();
    trackRegistrations(spy);
    await flushLazyImports();

    expect(mockClearKeychainIfFreshInstall).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMMKVKey).toHaveBeenCalledTimes(1);
    expect(mockInitMMKV).toHaveBeenCalledTimes(1);
    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockRegisterForegroundDrain).toHaveBeenCalledTimes(1);
    expect(mockRegisterForegroundConfirmDrain).toHaveBeenCalledTimes(1);
  });

  it('retries after a rejection but skips both getOrCreateMMKVKey and initMMKV', async () => {
    const spy = jest.spyOn(tokenManager, 'onTokensCleared');
    mockGetOrCreateDatabaseKey.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(bootstrap()).rejects.toThrow('keychain locked');

    // The failed run got as far as initializing MMKV.
    expect(mockGetOrCreateMMKVKey).toHaveBeenCalledTimes(1);
    expect(mockInitMMKV).toHaveBeenCalledTimes(1);
    expect(mockInitDatabase).not.toHaveBeenCalled();

    await expect(bootstrap()).resolves.toBeUndefined();
    trackRegistrations(spy);

    // The retry re-ran the sequence...
    expect(mockGetOrCreateDatabaseKey).toHaveBeenCalledTimes(2);
    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
    // ...but did not touch the Keychain for the MMKV key, nor re-init MMKV.
    expect(mockGetOrCreateMMKVKey).toHaveBeenCalledTimes(1);
    expect(mockInitMMKV).toHaveBeenCalledTimes(1);
  });

  // #912: the group-key reporter is installed BEFORE the first await, so a
  // failure in any awaited step below is still reported. Both assertions
  // matter: a reporter installed inside runBootstrap would survive the first
  // test but not the rejection one.
  it('installs the group-key reporter before the first await', async () => {
    await bootstrap();

    expect(mockInstallGroupKeyFailureReporter).toHaveBeenCalled();
    expect(
      mockInstallGroupKeyFailureReporter.mock.invocationCallOrder[0],
    ).toBeLessThan(mockClearKeychainIfFreshInstall.mock.invocationCallOrder[0]);
  });

  it('installs the group-key reporter even when a later step rejects', async () => {
    mockGetOrCreateMMKVKey.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(bootstrap()).rejects.toThrow('keychain locked');

    expect(mockInstallGroupKeyFailureReporter).toHaveBeenCalledTimes(1);
  });

  it('registers each listener exactly once across a rejection and retry', async () => {
    const spy = jest.spyOn(tokenManager, 'onTokensCleared');
    mockGetOrCreateDatabaseKey.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(bootstrap()).rejects.toThrow('keychain locked');
    await bootstrap();
    await bootstrap();
    trackRegistrations(spy);
    await flushLazyImports();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(handleTokensCleared);
    expect(mockRegisterForegroundDrain).toHaveBeenCalledTimes(1);
    expect(mockSchedulePendingMediaDrain).toHaveBeenCalledTimes(1);
    expect(mockRegisterForegroundConfirmDrain).toHaveBeenCalledTimes(1);
    expect(mockScheduleArchiveConfirmDrain).toHaveBeenCalledTimes(1);
    expect(mockRegisterForegroundNotificationSettingsSync).toHaveBeenCalledTimes(1);
  });
});
