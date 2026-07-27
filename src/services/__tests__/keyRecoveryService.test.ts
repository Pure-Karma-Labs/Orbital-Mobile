/**
 * Tests for keyRecoveryService — orchestration order, wrong password,
 * retry-skips-reset, SEC-H1 (skipServerReset), generation fencing,
 * ConflictError detection via authService.
 */

// ---------------------------------------------------------------------------
// Module mocks — MUST be before imports
// ---------------------------------------------------------------------------

const mockSentryCaptureMessage = jest.fn();
const mockSentryCaptureException = jest.fn();
const mockSentryAddBreadcrumb = jest.fn();
jest.mock('@sentry/react-native', () => ({
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
  addBreadcrumb: (...args: unknown[]) => mockSentryAddBreadcrumb(...args),
}));

jest.mock('../notificationService', () => ({
  deregisterCurrentDevice: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  CachesDirectoryPath: '/mock/caches',
  unlink: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
  readDir: jest.fn().mockResolvedValue([]),
}));

jest.mock('../secure-storage', () => ({
  clearAll: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../crypto/downgradeProtection', () => ({
  clearEciesLockState: jest.fn(),
  loadEciesLockState: jest.fn(),
}));

jest.mock('../threadService', () => ({
  clearProcessedMediaIds: jest.fn(),
}));

jest.mock('../api/auth', () => ({
  login: jest.fn(),
  signup: jest.fn(),
  verifyToken: jest.fn(),
}));

jest.mock('../api/terms', () => ({
  acceptTerms: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../config/termsPolicy', () => ({
  TERMS_VERSION: 1,
}));

jest.mock('../api/users', () => ({
  getMe: jest.fn(),
  deleteAccount: jest.fn(),
}));

jest.mock('../api/tokenManager', () => ({
  tokenManager: {
    getAccessToken: jest.fn(),
    setTokens: jest.fn(),
    clearTokens: jest.fn(),
    onTokensCleared: jest.fn(() => jest.fn()),
    onTokenRefresh: jest.fn(() => jest.fn()),
  },
}));

const mockResetIdentityKeys = jest.fn().mockResolvedValue(undefined);
const mockFetchRemoteIdentityKeyBundle = jest.fn().mockResolvedValue({ identityKey: 'base64-key' });
jest.mock('../api/keys', () => ({
  uploadPreKeyBundle: jest.fn().mockResolvedValue(undefined),
  getPreKeyCount: jest.fn().mockResolvedValue({ count: 100 }),
  fetchRemoteIdentityKeyBundle: (...args: unknown[]) => mockFetchRemoteIdentityKeyBundle(...args),
  resetIdentityKeys: (...args: unknown[]) => mockResetIdentityKeys(...args),
}));

const mockGenerateInitialKeys = jest.fn().mockResolvedValue(undefined);
const mockUploadInitialPreKeyBundle = jest.fn().mockResolvedValue(undefined);
const mockEnsureKeysInitialized = jest.fn().mockResolvedValue(undefined);
const mockClearIdentityKeyCache = jest.fn();
const mockFullCryptoWipe = jest.fn().mockResolvedValue(undefined);
const mockCancelKeyInitialization = jest.fn().mockResolvedValue(undefined);
const mockGetCachedIdentityPrivateKeyHex = jest.fn().mockReturnValue('deadbeef');

jest.mock('../crypto/keyGenerationService', () => ({
  generateInitialKeys: (...args: unknown[]) => mockGenerateInitialKeys(...args),
  uploadInitialPreKeyBundle: (...args: unknown[]) => mockUploadInitialPreKeyBundle(...args),
  ensureKeysInitialized: (...args: unknown[]) => mockEnsureKeysInitialized(...args),
  clearIdentityKeyCache: () => mockClearIdentityKeyCache(),
  fullCryptoWipe: (...args: unknown[]) => mockFullCryptoWipe(...args),
  cancelKeyInitialization: (...args: unknown[]) => mockCancelKeyInitialization(...args),
  getCachedIdentityPrivateKeyHex: () => mockGetCachedIdentityPrivateKeyHex(),
}));

const mockClearGroupKeyCache = jest.fn();
jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  clearGroupKeyCache: () => mockClearGroupKeyCache(),
  persistGroupKey: jest.fn(),
  clearContentCryptoInflight: jest.fn(),
}));

jest.mock('../crypto/inviteCrypto', () => ({
  stripInviteCode: jest.fn(),
  decryptGroupKeyFromInvite: jest.fn(),
}));

jest.mock('../crypto/utils', () => ({
  arrayBufferToBase64: jest.fn(() => 'base64-key'),
  toArrayBuffer: jest.fn((u8: Uint8Array) => u8.buffer),
}));

const mockItemStore: Record<string, string> = {
  identityKeyPublic: 'some-public-key-hex',
};
const mockGetItem = jest.fn((key: string) => mockItemStore[key] ?? null);
const mockSetItem = jest.fn((key: string, value: string) => { mockItemStore[key] = value; });
const mockRemoveItem = jest.fn((key: string) => { delete mockItemStore[key]; });
jest.mock('../../database/repositories/itemRepository', () => ({
  getItem: (key: string) => mockGetItem(key),
  setItem: (key: string, value: string) => mockSetItem(key, value),
  removeItem: (key: string) => mockRemoveItem(key),
}));

jest.mock('../../database/queryHelpers', () => ({
  execute: jest.fn(),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
  closeDatabase: jest.fn(),
}));

const mockClearAllArchiveConfirmations = jest.fn();
jest.mock('../../database/repositories/mediaRepository', () => ({
  clearAllArchiveConfirmations: () => mockClearAllArchiveConfirmations(),
}));

const mockLoadConversations = jest.fn().mockResolvedValue(undefined);
const mockLoadDmConversations = jest.fn().mockResolvedValue(undefined);
const mockFulfillPendingWraps = jest.fn().mockResolvedValue(undefined);
const mockHydrateContactsFromOrbits = jest.fn().mockResolvedValue(undefined);
jest.mock('../conversationService', () => ({
  loadConversations: (...args: unknown[]) => mockLoadConversations(...args),
  loadDmConversations: (...args: unknown[]) => mockLoadDmConversations(...args),
  fulfillPendingWraps: (...args: unknown[]) => mockFulfillPendingWraps(...args),
  hydrateContactsFromOrbits: (...args: unknown[]) => mockHydrateContactsFromOrbits(...args),
  selfWrapIfNeeded: jest.fn().mockResolvedValue(undefined),
  clearConversationServiceState: jest.fn(),
}));

jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: jest.fn(() => ({ clearAll: jest.fn() })),
}));

jest.mock('../avatarService');

jest.mock('../blockedUsersSync', () => ({
  syncBlockedUsers: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../websocket/messageHandler', () => ({
  clearMessageHandlerState: jest.fn(),
  handleServerMessage: jest.fn(),
}));

jest.mock('../websocket', () => ({
  websocketManager: {
    connect: jest.fn(),
    disconnect: jest.fn(),
  },
}));

jest.mock('../../database/repositories/threadRepository', () => ({
  clearAllThreads: jest.fn(),
}));
jest.mock('../../database/repositories/replyRepository', () => ({
  clearAllReplies: jest.fn(),
}));
jest.mock('../../hooks/useLinkPreview', () => ({
  clearLinkPreviewCache: jest.fn(),
}));
jest.mock('../crypto/identityKeyAccess', () => ({
  clearIdentityInflightState: jest.fn(),
}));

// Mock the whole store module
const mockSetUser = jest.fn();
const mockUpdateProfile = jest.fn();
const mockClearAuth = jest.fn();
const mockSetConversations = jest.fn();
const mockSetContacts = jest.fn();
const mockSetConnectionStatus = jest.fn();
const mockClearTypingUsers = jest.fn();
const mockSetNeedsTermsAcceptance = jest.fn();
const mockSetIdentityKeyConflict = jest.fn();
const mockSetKeyRecoveryInProgress = jest.fn();
const mockSetEmail = jest.fn();
const mockSetConflictSource = jest.fn();
const mockSetKeyRecoveryError = jest.fn();
const mockResetBlockedUsers = jest.fn();
const mockSetViewingConversation = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'user-1',
      email: 'alice@example.com',
      setUser: mockSetUser,
      updateProfile: mockUpdateProfile,
      clearAuth: mockClearAuth,
      setConversations: mockSetConversations,
      setContacts: mockSetContacts,
      setConnectionStatus: mockSetConnectionStatus,
      clearTypingUsers: mockClearTypingUsers,
      setNeedsTermsAcceptance: mockSetNeedsTermsAcceptance,
      setIdentityKeyConflict: mockSetIdentityKeyConflict,
      setKeyRecoveryInProgress: mockSetKeyRecoveryInProgress,
      setEmail: mockSetEmail,
      setConflictSource: mockSetConflictSource,
      setKeyRecoveryError: mockSetKeyRecoveryError,
      resetBlockedUsers: mockResetBlockedUsers,
      setViewingConversation: mockSetViewingConversation,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { recoverIdentityKeys, isRecoveryInitiator, probeServerIdentityKey, loginForRecoveryWithRetry } from '../keyRecoveryService';
import { ApiError, AuthError, ConflictError, NetworkError, NotFoundError } from '../api/errors';
import { websocketManager } from '../websocket';
import { useAppStore } from '../../stores/useAppStore';
import * as authApi from '../api/auth';
import { loadEciesLockState } from '../crypto/downgradeProtection';

const mockLogin = authApi.login as jest.Mock;
const mockWsConnect = websocketManager.connect as jest.Mock;
const mockWsDisconnect = websocketManager.disconnect as jest.Mock;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Reset item store to default state (keys exist = not yet wiped)
  Object.keys(mockItemStore).forEach((k) => delete mockItemStore[k]);
  mockItemStore.identityKeyPublic = 'some-public-key-hex';
  mockGetCachedIdentityPrivateKeyHex.mockReturnValue('deadbeef');
  // mockReset (not just clearAllMocks which only calls mockClear) to clear the
  // once queue — clearAllMocks leaves specificReturnValues/specificMockImpls intact,
  // causing stale values to accumulate across tests.
  mockFetchRemoteIdentityKeyBundle.mockReset();
  // Default: probe returns 'present' initially (step 4 triggers reset), then
  // 'absent' on post-login re-probe (step 6b skips extra reset cycle).
  // Tests that need different probe behavior call mockReset() first.
  mockFetchRemoteIdentityKeyBundle
    .mockResolvedValueOnce({ identityKey: 'base64-key' })
    .mockRejectedValueOnce(new NotFoundError());
  mockLogin.mockResolvedValue({
    token: 'new-jwt',
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    publicKey: null,
    needsTermsAcceptance: false,
  });
});

// ---------------------------------------------------------------------------
// Orchestration order
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — orchestration', () => {
  it('executes steps in correct order: WS disconnect → cancel → probe → reset → wipe → login → re-probe → keys → WS connect', async () => {
    const callOrder: string[] = [];
    mockWsDisconnect.mockImplementation(() => { callOrder.push('ws-disconnect'); });
    mockCancelKeyInitialization.mockImplementation(async () => { callOrder.push('cancel'); });
    // First probe: present (triggers reset); second probe (post-login): absent (no extra reset)
    let probeCallCount = 0;
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockImplementation(async () => {
      probeCallCount++;
      callOrder.push('probe');
      if (probeCallCount === 1) return { identityKey: 'base64-key' };
      throw new NotFoundError(); // post-login: absent
    });
    mockResetIdentityKeys.mockImplementation(async () => { callOrder.push('reset'); });
    mockFullCryptoWipe.mockImplementation(async () => { callOrder.push('wipe'); });
    mockLogin.mockImplementation(async () => {
      callOrder.push('login');
      return { token: 'tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null };
    });
    mockEnsureKeysInitialized.mockImplementation(async () => { callOrder.push('keys-init'); });
    mockWsConnect.mockImplementation(() => { callOrder.push('ws-connect'); });

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(callOrder).toEqual([
      'ws-disconnect',
      'cancel',
      'probe',      // step 4: probe server
      'reset',      // step 4: reset (probe=present)
      'wipe',       // step 5: local wipe
      'login',      // step 6: re-login
      'probe',      // step 6b: post-login re-probe
      'keys-init',  // step 7: key re-generation
      'ws-connect', // step 8: reconnect
    ]);
  });

  it('sets keyRecoveryInProgress=true on entry and false on exit', async () => {
    const result = await recoverIdentityKeys('password123', false);
    expect(result.status).toBe('success');
    // First call sets true, second call (in finally) sets false
    expect(mockSetKeyRecoveryInProgress).toHaveBeenCalledWith(true);
    expect(mockSetKeyRecoveryInProgress).toHaveBeenCalledWith(false);
    // false must be the last call
    const calls = mockSetKeyRecoveryInProgress.mock.calls;
    expect(calls[calls.length - 1][0]).toBe(false);
  });

  it('clears identityKeyConflict on success', async () => {
    const result = await recoverIdentityKeys('password123', false);
    expect(result.status).toBe('success');
    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(false);
  });

  it('calls explicit removeItem for lastUserId and bundleUploaded after wipe', async () => {
    const result = await recoverIdentityKeys('password123', false);
    expect(result.status).toBe('success');
    expect(mockRemoveItem).toHaveBeenCalledWith('lastUserId');
    expect(mockRemoveItem).toHaveBeenCalledWith('bundleUploaded');
  });
});

// ---------------------------------------------------------------------------
// Wrong password
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — wrong password', () => {
  it('returns incorrect_password on 403, does NOT wipe, does NOT proceed to login or key-init', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(new AuthError(403, 'bad password'));

    const result = await recoverIdentityKeys('wrong', false);

    expect(result).toEqual({ status: 'incorrect_password' });
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockEnsureKeysInitialized).not.toHaveBeenCalled();
    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalledWith(false);
    expect(mockSetConflictSource).not.toHaveBeenCalledWith(null);
    expect(mockWsConnect).toHaveBeenCalled(); // WS reconnected
  });
});

// ---------------------------------------------------------------------------
// SEC-H1: skipServerReset
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — SEC-H1 skipServerReset', () => {
  it('(a) skip=true → zero reset-API invocations', async () => {
    const result = await recoverIdentityKeys('password123', true);

    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalled();
  });

  it('(b) skip=false + post-login probe=absent → exactly one reset-API invocation', async () => {
    // First probe: present (triggers reset); post-login probe: absent (no extra reset)
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'base64-key' })
      .mockRejectedValueOnce(new NotFoundError());

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockResetIdentityKeys).toHaveBeenCalledWith('password123');
  });

  it('(c) skip=true + already-wiped → straight to loginForRecovery (no wipe)', async () => {
    // Simulate already-wiped state: identityKeyPublic absent
    delete mockItemStore.identityKeyPublic;

    const result = await recoverIdentityKeys('password123', true);

    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled(); // already wiped
    expect(mockLogin).toHaveBeenCalled();
  });

  it('(d) skip=false + locally-wiped + probe=present → STILL resets (loop-breaker)', async () => {
    // Simulate locally-wiped state: identityKeyPublic absent
    delete mockItemStore.identityKeyPublic;
    // Probe returns 'present' — server still has the key
    mockFetchRemoteIdentityKeyBundle.mockResolvedValue({ identityKey: 'base64-key' });

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    // This is the FIX: reset is called even though local state is wiped
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    // Local wipe skipped (already wiped)
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalled();
  });

  it('(e) skip=false + locally-wiped + probe=absent → skip reset (already landed on server)', async () => {
    delete mockItemStore.identityKeyPublic;
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockRejectedValue(new NotFoundError());

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State-aware retry (JWT catch-22)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — state-aware retry', () => {
  it('reset ok + wipe ok + login failed → retry with probe=absent skips reset', async () => {
    // First attempt: reset succeeds, wipe succeeds, login fails
    mockLogin.mockImplementation(async () => {
      throw new Error('network glitch');
    });

    // First call fails at login (probe=present from beforeEach → reset fires)
    const result1 = await recoverIdentityKeys('password123', false);
    expect(result1.status).toBe('error');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);

    // Simulate the already-wiped state for retry
    jest.clearAllMocks();
    delete mockItemStore.identityKeyPublic; // gone after wipe
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    // Server key is now absent (prior reset landed)
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockRejectedValue(new NotFoundError());
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null,
    });

    // Retry: probe=absent → skip reset; locally wiped → skip wipe; straight to login
    const result2 = await recoverIdentityKeys('password123', false);
    expect(result2.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalled();
  });

  it('reset ok + wipe ok + login failed → retry with probe=present DOES reset (loop-breaker)', async () => {
    // First attempt: reset succeeds, wipe succeeds, login fails
    mockLogin.mockRejectedValueOnce(new Error('network glitch'));

    const result1 = await recoverIdentityKeys('password123', false);
    expect(result1.status).toBe('error');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);

    // Retry: locally wiped, but server still has key (edge case the old code couldn't handle)
    jest.clearAllMocks();
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    // Server STILL has the key (reset didn't propagate, or race)
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockResolvedValue({ identityKey: 'base64-key' });
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null,
    });

    const result2 = await recoverIdentityKeys('password123', false);
    expect(result2.status).toBe('success');
    // THIS is the loop-breaker: reset is called despite local wipe
    // Two calls: step 4 (initial probe=present) + step 6b (post-login re-probe=present)
    expect(mockResetIdentityKeys).toHaveBeenCalledWith('password123');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(2);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled(); // already wiped
    expect(mockLogin).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API-M2: 401 auto-retry on re-login
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — API-M2 401 auto-retry', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('retries login once after 401 with ~1.5s delay', async () => {
    let loginAttempt = 0;
    mockLogin.mockImplementation(async () => {
      loginAttempt++;
      if (loginAttempt === 1) {
        throw new AuthError(401, 'jwt revoked');
      }
      return { token: 'new-tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null };
    });

    const promise = recoverIdentityKeys('password123', false);
    // Drain microtasks so the code reaches the setTimeout
    await jest.advanceTimersByTimeAsync(1600);
    const result = await promise;

    expect(result.status).toBe('success');
    expect(loginAttempt).toBe(2);
  });

  it('returns error when retry also fails with 401', async () => {
    mockLogin.mockRejectedValue(new AuthError(401, 'jwt revoked'));

    const promise = recoverIdentityKeys('password123', false);
    await jest.advanceTimersByTimeAsync(3200); // enough for both login retries
    const result = await promise;

    expect(result.status).toBe('error');
    expect(result).toHaveProperty('message');
  });
});

// ---------------------------------------------------------------------------
// Second 409 leaves conflict flag true
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — second 409', () => {
  it('leaves identityKeyConflict true when ensureKeysInitialized throws ConflictError', async () => {
    mockEnsureKeysInitialized.mockRejectedValueOnce(new ConflictError());

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('error');
    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('local');
  });
});

// ---------------------------------------------------------------------------
// Initiator flag
// ---------------------------------------------------------------------------

describe('isRecoveryInitiator', () => {
  it('is false before and after recovery', () => {
    expect(isRecoveryInitiator()).toBe(false);
  });

  it('is true during recovery execution', async () => {
    let flagDuringExecution = false;
    mockEnsureKeysInitialized.mockImplementation(async () => {
      flagDuringExecution = isRecoveryInitiator();
    });

    await recoverIdentityKeys('password123', false);
    expect(flagDuringExecution).toBe(true);
    expect(isRecoveryInitiator()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Email resolution
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — email resolution', () => {
  let defaultState: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    defaultState = store.getState();
  });

  afterEach(() => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    (store.getState as jest.Mock).mockReturnValue(defaultState);
    const usersApi = require('../api/users');
    (usersApi.getMe as jest.Mock).mockReset();
  });

  it('returns needs_email when email cannot be resolved automatically', async () => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    (store.getState as jest.Mock).mockReturnValue({
      ...defaultState,
      email: null,
    });
    const usersApi = require('../api/users');
    (usersApi.getMe as jest.Mock).mockRejectedValue(new Error('no jwt'));

    const result = await recoverIdentityKeys('password123', false);
    expect(result.status).toBe('needs_email');
  });

  it('uses emailOverride when provided (manual entry fallback)', async () => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    (store.getState as jest.Mock).mockReturnValue({
      ...defaultState,
      email: null,
    });

    const result = await recoverIdentityKeys('password123', false, 'manual@example.com');
    expect(result.status).toBe('success');
    // Verify login was called (email was accepted)
    expect(mockLogin).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SEC-M1: fullCryptoWipe failure
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — fullCryptoWipe failure (SEC-M1)', () => {
  it('returns error when fullCryptoWipe rejects', async () => {
    mockFullCryptoWipe.mockRejectedValueOnce(new Error('wipe crashed'));

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('error');
    expect(result).toHaveProperty('message', 'Local wipe failed — please retry');
    expect(mockLogin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SEC-L2: 429 rate limit (ApiError, not AuthError)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — rate limit (SEC-L2)', () => {
  it('returns rate_limited on ApiError 429', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(
      new ApiError('Rate limited — try again shortly', 429, 'RATE_LIMITED', true),
    );

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('rate_limited');
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockWsConnect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reentrancy guard (single-flight coalescing)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — reentrancy guard', () => {
  it('(a) concurrent calls coalesce — mocks called exactly once', async () => {
    // Make login hang on a manually-resolved deferred so the first call
    // stays in-flight when the second call arrives.
    let resolveLogin!: (value: unknown) => void;
    const loginDeferred = new Promise((resolve) => { resolveLogin = resolve; });
    mockLogin.mockImplementation(() => loginDeferred);

    const p1 = recoverIdentityKeys('password123', false);
    const p2 = recoverIdentityKeys('password123', false);

    // Both promises reference the same in-flight work — resolve it.
    resolveLogin({
      token: 'tok', userId: 'user-1', username: 'alice',
      displayName: null, publicKey: null, needsTermsAcceptance: false,
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe('success');
    expect(r2.status).toBe('success');
    // Underlying side-effects ran exactly once, not twice.
    expect(mockWsDisconnect).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('(b) sequential calls are not blocked — each invocation runs independently', async () => {
    const r1 = await recoverIdentityKeys('password123', false);
    expect(r1.status).toBe('success');

    jest.clearAllMocks();
    // Restore item store defaults (first run's wipe removed identityKeyPublic)
    mockItemStore.identityKeyPublic = 'some-public-key-hex';
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue('deadbeef');
    // Re-setup probe mock (clearAllMocks resets it)
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'base64-key' })
      .mockRejectedValueOnce(new NotFoundError());
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice',
      displayName: null, publicKey: null, needsTermsAcceptance: false,
    });

    const r2 = await recoverIdentityKeys('password123', false);
    expect(r2.status).toBe('success');
    expect(mockWsDisconnect).toHaveBeenCalledTimes(1);
  });

  it('(c) error status propagation — both concurrent callers receive the same error result', async () => {
    // Make an inner step reject unexpectedly (doRecoverIdentityKeys catches
    // wipe failures and resolves with { status: 'error' } — it never rejects).
    mockFullCryptoWipe.mockRejectedValueOnce(new Error('disk failure'));

    const p1 = recoverIdentityKeys('password123', false);
    const p2 = recoverIdentityKeys('password123', false);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe('error');
    expect(r2.status).toBe('error');
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// loadEciesLockState guard (Item 4)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — loadEciesLockState guard', () => {
  it('recovery succeeds even when loadEciesLockState throws', async () => {
    (loadEciesLockState as jest.Mock).mockImplementation(() => {
      throw new Error('corrupt lock state');
    });

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    // Subsequent bootstrap mocks still ran
    expect(mockLoadConversations).toHaveBeenCalled();
    expect(mockLoadDmConversations).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearAllArchiveConfirmations — called unconditionally for all recovery shapes
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — clearAllArchiveConfirmations', () => {
  it('calls clearAllArchiveConfirmations on success with skipServerReset=false', async () => {
    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(mockClearAllArchiveConfirmations).toHaveBeenCalledTimes(1);
  });

  it('calls clearAllArchiveConfirmations on success with skipServerReset=true', async () => {
    const result = await recoverIdentityKeys('password123', true);

    expect(result.status).toBe('success');
    expect(mockClearAllArchiveConfirmations).toHaveBeenCalledTimes(1);
  });

  it('calls clearAllArchiveConfirmations even on the locallyWiped path', async () => {
    // Simulate locally-wiped state: identityKeyPublic absent
    delete mockItemStore.identityKeyPublic;

    const result = await recoverIdentityKeys('password123', true);

    expect(result.status).toBe('success');
    // clearAllArchiveConfirmations is OUTSIDE the if(!locallyWiped) guard
    expect(mockClearAllArchiveConfirmations).toHaveBeenCalledTimes(1);
  });

  it('is best-effort — recovery succeeds even if clearAllArchiveConfirmations throws', async () => {
    mockClearAllArchiveConfirmations.mockImplementation(() => {
      throw new Error('DB error');
    });

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(mockClearAllArchiveConfirmations).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Store-hoisted keyRecoveryError (Fix 2a)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — store-hoisted keyRecoveryError', () => {
  it('clears keyRecoveryError on start', async () => {
    await recoverIdentityKeys('password123', false);
    // First call to setKeyRecoveryError should be null (clear on start)
    expect(mockSetKeyRecoveryError.mock.calls[0][0]).toBeNull();
  });

  it('writes incorrect_password to store on 403', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(new AuthError(403, 'bad password'));
    await recoverIdentityKeys('wrong', false);
    expect(mockSetKeyRecoveryError).toHaveBeenCalledWith({ status: 'incorrect_password' });
  });

  it('writes rate_limited to store on 429', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(
      new ApiError('Rate limited', 429, 'RATE_LIMITED', true),
    );
    await recoverIdentityKeys('pw', false);
    expect(mockSetKeyRecoveryError).toHaveBeenCalledWith({ status: 'rate_limited' });
  });

  it('writes needs_email to store when email unresolvable', async () => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    const defaultState = store.getState();
    (store.getState as jest.Mock).mockReturnValue({ ...defaultState, email: null });
    const usersApi = require('../api/users');
    (usersApi.getMe as jest.Mock).mockRejectedValue(new Error('no jwt'));

    await recoverIdentityKeys('pw', false);
    expect(mockSetKeyRecoveryError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs_email' }),
    );

    // Restore
    (store.getState as jest.Mock).mockReturnValue(defaultState);
    (usersApi.getMe as jest.Mock).mockReset();
  });

  it('writes error with message to store on wipe failure', async () => {
    mockFullCryptoWipe.mockRejectedValueOnce(new Error('wipe crashed'));
    await recoverIdentityKeys('pw', false);
    expect(mockSetKeyRecoveryError).toHaveBeenCalledWith({
      status: 'error',
      message: 'Local wipe failed — please retry',
    });
  });

  it('writes error to store on second 409', async () => {
    mockEnsureKeysInitialized.mockRejectedValueOnce(new ConflictError());
    await recoverIdentityKeys('pw', false);
    expect(mockSetKeyRecoveryError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', message: expect.stringContaining('conflict persists') }),
    );
  });

  it('does NOT write to store on success', async () => {
    await recoverIdentityKeys('pw', false);
    // Only the initial clear (null) — no error written
    const errorCalls = mockSetKeyRecoveryError.mock.calls.filter(
      (c: unknown[]) => c[0] !== null,
    );
    expect(errorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sentry telemetry (Fix 2b)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — Sentry telemetry', () => {
  it('adds breadcrumbs during successful recovery', async () => {
    await recoverIdentityKeys('pw', false);
    // At minimum: step-1 through step-8 breadcrumbs
    expect(mockSentryAddBreadcrumb).toHaveBeenCalled();
    const categories = mockSentryAddBreadcrumb.mock.calls.map(
      (c: unknown[]) => (c[0] as { category: string }).category,
    );
    expect(categories.every((c: string) => c === 'key-recovery')).toBe(true);
  });

  it('captureMessage(warning) on needs_email (email unresolvable)', async () => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    const defaultState = store.getState();
    (store.getState as jest.Mock).mockReturnValue({ ...defaultState, email: null });
    const usersApi = require('../api/users');
    (usersApi.getMe as jest.Mock).mockRejectedValue(new Error('no jwt'));

    await recoverIdentityKeys('pw', false);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('needs_email'),
      expect.objectContaining({ level: 'warning', tags: { feature: 'key-recovery' } }),
    );
    (store.getState as jest.Mock).mockReturnValue(defaultState);
  });

  it('captureMessage(warning) on incorrect_password (403)', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(new AuthError(403, 'bad'));
    await recoverIdentityKeys('bad', false);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('incorrect password'),
      expect.objectContaining({ level: 'warning', tags: { feature: 'key-recovery' } }),
    );
  });

  it('captureMessage(warning) on rate_limited (429)', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(
      new ApiError('Rate limited', 429, 'RATE_LIMITED', true),
    );
    await recoverIdentityKeys('pw', false);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rate limited'),
      expect.objectContaining({ level: 'warning', tags: { feature: 'key-recovery' } }),
    );
  });

  it('captureException on local wipe failure', async () => {
    mockFullCryptoWipe.mockRejectedValueOnce(new Error('disk error'));
    await recoverIdentityKeys('pw', false);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { feature: 'key-recovery' } }),
    );
  });

  it('captureException on second 409 (conflict persists)', async () => {
    mockEnsureKeysInitialized.mockRejectedValueOnce(new ConflictError());
    await recoverIdentityKeys('pw', false);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(ConflictError),
      expect.objectContaining({
        tags: { feature: 'key-recovery' },
        extra: { step: 'second-409-conflict-persists' },
      }),
    );
  });

  it('captureException on re-login retry exhaustion', async () => {
    jest.useFakeTimers();
    mockLogin.mockRejectedValue(new AuthError(401, 'revoked'));
    const promise = recoverIdentityKeys('pw', false);
    await jest.advanceTimersByTimeAsync(1600);
    await promise;
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { feature: 'key-recovery' },
        extra: { step: 're-login-retry-exhausted' },
      }),
    );
    jest.useRealTimers();
  });

  it('warnAndCapture captures post-recovery sync failures to Sentry', async () => {
    mockLoadConversations.mockRejectedValueOnce(new Error('sync fail'));
    await recoverIdentityKeys('pw', false);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { feature: 'key-recovery' },
        extra: { step: '[Recovery:ConversationSync]' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// probeServerIdentityKey — unit tests (Fix 2c)
// ---------------------------------------------------------------------------

describe('probeServerIdentityKey', () => {
  beforeEach(() => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
  });

  it('returns "present" when fetchRemoteIdentityKeyBundle resolves (200)', async () => {
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({ identityKey: 'key' });
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('present');
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server-probe: present' }),
    );
  });

  it('returns "absent" on NotFoundError (404)', async () => {
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new NotFoundError());
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('absent');
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server-probe: absent (404)' }),
    );
  });

  it('returns "absent" on generic ApiError with statusCode 404', async () => {
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(
      new ApiError('Not found', 404, 'NOT_FOUND', false),
    );
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('absent');
  });

  it('returns "unauthorized" on AuthError 401', async () => {
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new AuthError(401, 'revoked'));
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('unauthorized');
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server-probe: unauthorized (401)' }),
    );
  });

  it('returns "unreachable" on NetworkError', async () => {
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new NetworkError('timeout'));
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('unreachable');
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server-probe: unreachable' }),
    );
  });

  it('returns "unreachable" on unexpected errors', async () => {
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new Error('something weird'));
    const result = await probeServerIdentityKey('user-1');
    expect(result).toBe('unreachable');
  });
});

// ---------------------------------------------------------------------------
// loginForRecoveryWithRetry — unit tests
// ---------------------------------------------------------------------------

describe('loginForRecoveryWithRetry', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('succeeds on first attempt without retry', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'tok', userId: 'user-1', username: 'alice',
      displayName: null, publicKey: null, needsTermsAcceptance: false,
    });

    const promise = loginForRecoveryWithRetry('alice@example.com', 'pw');
    await jest.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBeUndefined();
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('retries once on 401, succeeds on second attempt', async () => {
    mockLogin
      .mockRejectedValueOnce(new AuthError(401, 'revoked'))
      .mockResolvedValueOnce({
        token: 'tok', userId: 'user-1', username: 'alice',
        displayName: null, publicKey: null, needsTermsAcceptance: false,
      });

    const promise = loginForRecoveryWithRetry('alice@example.com', 'pw');
    await jest.advanceTimersByTimeAsync(1600);
    await expect(promise).resolves.toBeUndefined();
    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  it('throws on 401 retry failure (both attempts 401)', async () => {
    mockLogin.mockRejectedValue(new AuthError(401, 'revoked'));

    const promise = loginForRecoveryWithRetry('alice@example.com', 'pw');
    // Attach the rejection assertion BEFORE advancing timers to prevent
    // the unhandled-rejection race (fake timers flush microtasks during advance).
    const assertion = expect(promise).rejects.toBeInstanceOf(AuthError);
    await jest.advanceTimersByTimeAsync(1600);
    await assertion;
    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-401 errors (no retry)', async () => {
    mockLogin.mockRejectedValueOnce(new AuthError(403, 'forbidden'));

    const promise = loginForRecoveryWithRetry('alice@example.com', 'pw');
    // No timer involved (non-401 re-throws immediately), but assertion
    // must still attach before any await to prevent unhandled rejection.
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Server-truth probe matrix (Fix 2c) — comprehensive integration tests
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — probe matrix', () => {
  // Matrix: (present|absent|unauthorized|unreachable) x (locally-wiped|not) x skipServerReset

  // --- skipServerReset=false, NOT locally wiped ---

  it('probe=present + not-wiped + skip=false → resets + wipes + succeeds', async () => {
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })   // step 4 probe
      .mockRejectedValueOnce(new NotFoundError());      // step 6b re-probe
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);
  });

  it('probe=absent + not-wiped + skip=false → skips reset, still wipes', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockRejectedValueOnce(new NotFoundError())       // step 4: absent
      .mockRejectedValueOnce(new NotFoundError());      // step 6b: still absent
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);
  });

  it('probe=unauthorized + not-wiped + skip=false → skips reset, still wipes', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockRejectedValueOnce(new AuthError(401, 'revoked'))  // step 4: unauthorized
      .mockRejectedValueOnce(new NotFoundError());           // step 6b re-probe
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);
  });

  it('probe=unreachable + not-wiped + skip=false → returns error, NO destructive action', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new NetworkError('timeout'));
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('error');
    expect(result).toHaveProperty('message', 'Network error — please check your connection');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockEnsureKeysInitialized).not.toHaveBeenCalled();
  });

  // --- skipServerReset=false, LOCALLY wiped ---

  it('probe=present + locally-wiped + skip=false → resets (loop-breaker), skips wipe', async () => {
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })
      .mockRejectedValueOnce(new NotFoundError());
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('probe=absent + locally-wiped + skip=false → skips reset + wipe', async () => {
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockRejectedValueOnce(new NotFoundError())
      .mockRejectedValueOnce(new NotFoundError());
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('probe=unauthorized + locally-wiped + skip=false → skips reset + wipe', async () => {
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockRejectedValueOnce(new AuthError(401, 'revoked'))
      .mockRejectedValueOnce(new NotFoundError());
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('probe=unreachable + locally-wiped + skip=false → returns error, NO destructive action', async () => {
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle.mockRejectedValueOnce(new NetworkError('timeout'));
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('error');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  // --- skipServerReset=true (SEC-H1 push path) ---

  it('skip=true + not-wiped → never probes, never resets, wipes + succeeds', async () => {
    const result = await recoverIdentityKeys('pw', true);
    expect(result.status).toBe('success');
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);
  });

  it('skip=true + locally-wiped → never probes, never resets, skips wipe', async () => {
    delete mockItemStore.identityKeyPublic;
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    const result = await recoverIdentityKeys('pw', true);
    expect(result.status).toBe('success');
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Post-login re-probe safety net (Fix 2c step 6b)
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — post-login re-probe', () => {
  it('re-probe=present triggers reset + re-login after initial login', async () => {
    // Initial probe: present → reset. Post-login probe: ALSO present → second reset + re-login
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })   // step 4: present
      .mockResolvedValueOnce({ identityKey: 'key' });  // step 6b: still present
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    // Two resets: step 4 + step 6b
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(2);
    // Two login attempts: step 6 + step 6b re-login
    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  it('re-probe=absent does NOT trigger second reset or re-login', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })  // step 4: present
      .mockRejectedValueOnce(new NotFoundError());    // step 6b: absent
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('re-probe is skipped when skipServerReset=true', async () => {
    const result = await recoverIdentityKeys('pw', true);
    expect(result.status).toBe('success');
    // No probes at all
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('post-login reset failure is non-fatal — proceeds to key-init', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })
      .mockResolvedValueOnce({ identityKey: 'key' });
    // First reset succeeds (step 4), second reset fails (step 6b)
    mockResetIdentityKeys
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('server hiccup'));
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { step: 'post-login-reset' } }),
    );
    // Failed reset did NOT revoke the JWT — no extra re-login (#632 panel item 1)
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('re-probe=unauthorized proceeds to key-init without second reset', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' }) // step 4: present
      .mockRejectedValueOnce(new AuthError(401, 'revoked')); // step 6b: unauthorized
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockEnsureKeysInitialized).toHaveBeenCalled();
  });

  it('re-probe=unreachable proceeds to key-init without second reset', async () => {
    mockFetchRemoteIdentityKeyBundle.mockReset();
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' }) // step 4: present
      .mockRejectedValueOnce(new NetworkError('offline')); // step 6b: unreachable
    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockEnsureKeysInitialized).toHaveBeenCalled();
  });

  it('null userId skips probe AND reset entirely, still wipes + logs in', async () => {
    const { useAppStore: store } = require('../../stores/useAppStore');
    const defaultState = store.getState();
    (store.getState as jest.Mock).mockReturnValue({ ...defaultState, userId: null });

    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('success');
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalled();

    (store.getState as jest.Mock).mockReturnValue(defaultState);
  });

  it('second-409 "Key conflict persists" branch still reachable after re-probe', async () => {
    mockFetchRemoteIdentityKeyBundle
      .mockResolvedValueOnce({ identityKey: 'key' })
      .mockRejectedValueOnce(new NotFoundError());
    mockEnsureKeysInitialized.mockRejectedValueOnce(new ConflictError());

    const result = await recoverIdentityKeys('pw', false);
    expect(result.status).toBe('error');
    expect(result).toHaveProperty('message', expect.stringContaining('conflict persists'));
    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
  });
});
