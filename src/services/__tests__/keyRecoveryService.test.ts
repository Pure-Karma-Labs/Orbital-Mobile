/**
 * Tests for keyRecoveryService — orchestration order, wrong password,
 * retry-skips-reset, SEC-H1 (skipServerReset), generation fencing,
 * ConflictError detection via authService.
 */

// ---------------------------------------------------------------------------
// Module mocks — MUST be before imports
// ---------------------------------------------------------------------------

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
jest.mock('../api/keys', () => ({
  uploadPreKeyBundle: jest.fn().mockResolvedValue(undefined),
  getPreKeyCount: jest.fn().mockResolvedValue({ count: 100 }),
  fetchRemoteIdentityKeyBundle: jest.fn(),
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
      resetBlockedUsers: mockResetBlockedUsers,
      setViewingConversation: mockSetViewingConversation,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { recoverIdentityKeys, isRecoveryInitiator } from '../keyRecoveryService';
import { AuthError, ConflictError } from '../api/errors';
import { websocketManager } from '../websocket';
import * as authApi from '../api/auth';

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
  it('executes steps in correct order: WS disconnect → cancel → reset → wipe → login → keys → WS connect', async () => {
    const callOrder: string[] = [];
    mockWsDisconnect.mockImplementation(() => { callOrder.push('ws-disconnect'); });
    mockCancelKeyInitialization.mockImplementation(async () => { callOrder.push('cancel'); });
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
      'reset',
      'wipe',
      'login',
      'keys-init',
      'ws-connect',
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
  it('returns incorrect_password on 403 and does NOT wipe', async () => {
    mockResetIdentityKeys.mockRejectedValueOnce(new AuthError(403, 'bad password'));

    const result = await recoverIdentityKeys('wrong', false);

    expect(result).toEqual({ status: 'incorrect_password' });
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
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

  it('(b) skip=false → exactly one reset-API invocation', async () => {
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

  it('(d) skip=false + already-wiped → skip reset, straight to loginForRecovery', async () => {
    // Simulate already-wiped state
    delete mockItemStore.identityKeyPublic;

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
  it('reset ok + wipe ok + login failed → retry calls login without calling reset', async () => {
    // First attempt: reset succeeds, wipe succeeds, login fails
    let loginCallCount = 0;
    mockLogin.mockImplementation(async () => {
      loginCallCount++;
      if (loginCallCount === 1) {
        throw new Error('network glitch');
      }
      return { token: 'tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null };
    });

    // First call fails at login
    const result1 = await recoverIdentityKeys('password123', false);
    expect(result1.status).toBe('error');
    expect(mockResetIdentityKeys).toHaveBeenCalledTimes(1);
    expect(mockFullCryptoWipe).toHaveBeenCalledTimes(1);

    // Simulate the already-wiped state for retry
    jest.clearAllMocks();
    delete mockItemStore.identityKeyPublic; // gone after wipe
    mockGetCachedIdentityPrivateKeyHex.mockReturnValue(null);
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null,
    });

    // Retry: should skip reset and wipe, go straight to login
    const result2 = await recoverIdentityKeys('password123', false);
    expect(result2.status).toBe('success');
    expect(mockResetIdentityKeys).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API-M2: 401 auto-retry on re-login
// ---------------------------------------------------------------------------

describe('recoverIdentityKeys — API-M2 401 auto-retry', () => {
  it('retries login once after 401', async () => {
    let loginAttempt = 0;
    mockLogin.mockImplementation(async () => {
      loginAttempt++;
      if (loginAttempt === 1) {
        throw new AuthError(401, 'jwt revoked');
      }
      return { token: 'new-tok', userId: 'user-1', username: 'alice', displayName: null, publicKey: null };
    });

    const result = await recoverIdentityKeys('password123', false);

    expect(result.status).toBe('success');
    expect(loginAttempt).toBe(2);
  }, 10000);
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
  it('returns error when email cannot be resolved', async () => {
    const { useAppStore } = require('../../stores/useAppStore');
    const defaultState = useAppStore.getState();
    // All getState calls must return email: null to force fallback to getMe
    (useAppStore.getState as jest.Mock).mockReturnValue({
      ...defaultState,
      email: null,
    });
    const usersApi = require('../api/users');
    (usersApi.getMe as jest.Mock).mockRejectedValue(new Error('no jwt'));

    const result = await recoverIdentityKeys('password123', false);
    expect(result.status).toBe('error');
    expect(result).toHaveProperty('message');

    // Restore default for subsequent tests
    (useAppStore.getState as jest.Mock).mockReturnValue(defaultState);
    (usersApi.getMe as jest.Mock).mockReset();
  });
});
