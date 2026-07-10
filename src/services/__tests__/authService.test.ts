/**
 * Tests for authService — login, signup, session restore, logout, deleteAccount orchestration.
 */

import { loginUser, signupUser, restoreSession, logout, deleteAccount, acceptCurrentTerms, checkAccountSwitch, loginForRecovery } from '../authService';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mocks needed by imports added for deleteAccount/localWipe
jest.mock('../notificationService', () => ({
  deregisterCurrentDevice: jest.fn().mockResolvedValue(undefined),
}));

const mockUnlink = jest.fn().mockResolvedValue(undefined);
const mockExists = jest.fn().mockResolvedValue(false);
const mockReadDir = jest.fn().mockResolvedValue([]);
const MOCK_DOC_DIR = '/mock/documents';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  CachesDirectoryPath: '/mock/caches',
  unlink: (...args: unknown[]) => mockUnlink(...args),
  exists: (...args: unknown[]) => mockExists(...args),
  readDir: (...args: unknown[]) => mockReadDir(...args),
}));

const mockClearSecureStorage = jest.fn().mockResolvedValue(undefined);
jest.mock('../secure-storage', () => ({
  clearAll: (...args: unknown[]) => mockClearSecureStorage(...args),
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

const mockAcceptTerms = jest.fn().mockResolvedValue({
  accepted: true,
  termsVersion: 1,
  termsAcceptedAt: '2026-07-04T00:00:00Z',
});
jest.mock('../api/terms', () => ({
  acceptTerms: (...args: unknown[]) => mockAcceptTerms(...args),
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

// Mock key generation service — requires native TurboModule not available in Jest
const mockGenerateInitialKeys = jest.fn().mockResolvedValue(undefined);
const mockUploadInitialPreKeyBundle = jest.fn().mockResolvedValue(undefined);
const mockEnsureKeysInitialized = jest.fn().mockResolvedValue(undefined);
const mockClearIdentityKeyCache = jest.fn();
const mockFullCryptoWipe = jest.fn().mockResolvedValue(undefined);

jest.mock('../crypto/keyGenerationService', () => ({
  generateInitialKeys: (...args: unknown[]) => mockGenerateInitialKeys(...args),
  uploadInitialPreKeyBundle: (...args: unknown[]) => mockUploadInitialPreKeyBundle(...args),
  ensureKeysInitialized: (...args: unknown[]) => mockEnsureKeysInitialized(...args),
  clearIdentityKeyCache: () => mockClearIdentityKeyCache(),
  fullCryptoWipe: (...args: unknown[]) => mockFullCryptoWipe(...args),
}));

const mockClearGroupKeyCache = jest.fn();
const mockPersistGroupKey = jest.fn();
jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  clearGroupKeyCache: () => mockClearGroupKeyCache(),
  persistGroupKey: (...args: unknown[]) => mockPersistGroupKey(...args),
  clearContentCryptoInflight: jest.fn(),
}));

const mockStripInviteCode = jest.fn((s: string) => s.replace(/-/g, '').toUpperCase());
const mockDecryptGroupKeyFromInvite = jest.fn((_a: string, _b: string, _c: string) => new Uint8Array(32));
jest.mock('../crypto/inviteCrypto', () => ({
  stripInviteCode: (s: string) => mockStripInviteCode(s),
  decryptGroupKeyFromInvite: (a: string, b: string, c: string) => mockDecryptGroupKeyFromInvite(a, b, c),
}));

jest.mock('../crypto/utils', () => ({
  arrayBufferToBase64: jest.fn(() => 'base64-key'),
  toArrayBuffer: jest.fn((u8: Uint8Array) => u8.buffer),
}));

const mockGetItem = jest.fn().mockReturnValue(null);
const mockSetItem = jest.fn();
jest.mock('../../database/repositories/itemRepository', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

const mockExecute = jest.fn();
jest.mock('../../database/queryHelpers', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));

const mockCloseDatabase = jest.fn();
jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
  closeDatabase: () => mockCloseDatabase(),
}));

const mockLoadConversations = jest.fn().mockResolvedValue(undefined);
const mockLoadDmConversations = jest.fn().mockResolvedValue(undefined);
const mockFulfillPendingWraps = jest.fn().mockResolvedValue(undefined);
const mockHydrateContactsFromOrbits = jest.fn().mockResolvedValue(undefined);
const mockSelfWrapIfNeeded = jest.fn().mockResolvedValue(undefined);
jest.mock('../conversationService', () => ({
  loadConversations: (...args: unknown[]) => mockLoadConversations(...args),
  loadDmConversations: (...args: unknown[]) => mockLoadDmConversations(...args),
  fulfillPendingWraps: (...args: unknown[]) => mockFulfillPendingWraps(...args),
  hydrateContactsFromOrbits: (...args: unknown[]) => mockHydrateContactsFromOrbits(...args),
  selfWrapIfNeeded: (...args: unknown[]) => mockSelfWrapIfNeeded(...args),
  clearConversationServiceState: jest.fn(),
}));

jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: jest.fn(() => ({ clearAll: jest.fn() })),
}));

jest.mock('../avatarService');

const mockSyncBlockedUsers = jest.fn().mockResolvedValue(undefined);
jest.mock('../blockedUsersSync', () => ({
  syncBlockedUsers: (...args: unknown[]) => mockSyncBlockedUsers(...args),
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

// Mock the whole store module — we just want to verify action calls
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
      email: null,
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
// Import mocked modules for assertion
// ---------------------------------------------------------------------------

import * as authApi from '../api/auth';
import * as usersApi from '../api/users';
import { tokenManager } from '../api/tokenManager';
import { AccountSwitchError, ConflictError, NetworkError, AuthError } from '../api/errors';
import { websocketManager } from '../websocket';

const mockLogin = authApi.login as jest.Mock;
const mockSignup = authApi.signup as jest.Mock;
const mockVerifyToken = authApi.verifyToken as jest.Mock;
const mockGetMe = usersApi.getMe as jest.Mock;
const mockDeleteAccountApi = usersApi.deleteAccount as jest.Mock;
const mockGetAccessToken = tokenManager.getAccessToken as jest.Mock;
const mockSetTokens = tokenManager.setTokens as jest.Mock;
const mockClearTokens = tokenManager.clearTokens as jest.Mock;
const mockWsConnect = websocketManager.connect as jest.Mock;
const mockWsDisconnect = websocketManager.disconnect as jest.Mock;

import { isDatabaseInitialized } from '../../database/connection';
const mockIsDatabaseInitialized = isDatabaseInitialized as jest.Mock;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Restore default mock return values that tests may override —
  // clearAllMocks only clears tracking (calls/results), NOT mockReturnValue.
  mockGetItem.mockReturnValue(null);
  mockIsDatabaseInitialized.mockReturnValue(true);
  // Restore async mock defaults (clearAllMocks removes mockResolvedValue)
  mockGenerateInitialKeys.mockResolvedValue(undefined);
  mockUploadInitialPreKeyBundle.mockResolvedValue(undefined);
  mockEnsureKeysInitialized.mockResolvedValue(undefined);
  mockFullCryptoWipe.mockResolvedValue(undefined);
  mockLoadConversations.mockResolvedValue(undefined);
  mockLoadDmConversations.mockResolvedValue(undefined);
  mockFulfillPendingWraps.mockResolvedValue(undefined);
  mockHydrateContactsFromOrbits.mockResolvedValue(undefined);
  mockSelfWrapIfNeeded.mockResolvedValue(undefined);
  mockSyncBlockedUsers.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// loginUser
// ---------------------------------------------------------------------------

describe('loginUser', () => {
  it('calls login API, stores tokens, and populates store', async () => {
    mockLogin.mockResolvedValue({
      token: 'access-123',
      userId: 'user-1',
      username: 'alice',
      publicKey: { kty: 'EC', crv: 'P-256' },
    });

    await loginUser('alice', 'secret');

    expect(mockLogin).toHaveBeenCalledWith({ email: 'alice', password: 'secret' });
    expect(mockSetTokens).toHaveBeenCalledWith('access-123', undefined);
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice',
      displayName: null,
      avatarPath: null,
    });
  });

  it('passes displayName from login response to store when present', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'bob',
      displayName: 'Bobby',
      publicKey: null,
    });

    await loginUser('bob', 'pass');

    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Bobby', avatarPath: null }),
    );
  });

  it('falls back to null displayName when backend omits it (backward compat)', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'bob',
      publicKey: null,
    });

    await loginUser('bob', 'pass');

    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: null, avatarPath: null }),
    );
  });

  it('propagates API errors to the caller', async () => {
    mockLogin.mockRejectedValue(new AuthError(401, 'bad creds'));

    await expect(loginUser('bad', 'creds')).rejects.toBeInstanceOf(AuthError);
    expect(mockSetTokens).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  it('fires ensureKeysInitialized after login', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
    });

    await loginUser('alice', 'secret');

    expect(mockEnsureKeysInitialized).toHaveBeenCalledTimes(1);
  });

  it('loads DM conversations after login', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
    });

    await loginUser('alice', 'secret');

    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });

  it('hydrates contacts from orbits after login', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
    });

    await loginUser('alice', 'secret');

    expect(mockHydrateContactsFromOrbits).toHaveBeenCalledTimes(1);
  });

  it('throws AccountSwitchError when a different user tries to log in', async () => {
    mockGetItem.mockReturnValue('different-user');
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
    });

    await expect(loginUser('alice', 'secret')).rejects.toBeInstanceOf(AccountSwitchError);
    expect(mockSetTokens).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('hydrates needsTermsAcceptance=true from login response', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
      needsTermsAcceptance: true,
    });

    await loginUser('alice', 'secret');

    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(true);
  });

  it('hydrates needsTermsAcceptance=false from login response', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
      needsTermsAcceptance: false,
    });

    await loginUser('alice', 'secret');

    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
  });

  it('defaults needsTermsAcceptance to false when absent (backward compat)', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'alice',
      publicKey: null,
    });

    await loginUser('alice', 'secret');

    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// signupUser
// ---------------------------------------------------------------------------

describe('signupUser', () => {
  it('calls signup API, stores tokens, and populates store with null displayName/avatarPath', async () => {
    mockSignup.mockResolvedValue({
      token: 'access-abc',
      userId: 'user-2',
      username: 'dave',
      email: 'dave@example.com',
      groupId: 'group-1',
      inviteEncryptedGroupKey: null,
    });

    await signupUser('dave', 'password', 'dave@example.com', 'INV-CODE');

    expect(mockSignup).toHaveBeenCalledWith({
      username: 'dave',
      password: 'password',
      email: 'dave@example.com',
      inviteCode: 'INV-CODE',
      publicKey: { type: 'placeholder' },
      termsVersion: 1,
    });
    expect(mockSetTokens).toHaveBeenCalledWith('access-abc', undefined);
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'user-2',
      username: 'dave',
      displayName: null,
      avatarPath: null,
    });
  });

  it('includes termsVersion in signup request body', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'dave',
      email: 'dave@example.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('dave', 'password', 'dave@example.com', 'INV-CODE');

    expect(mockSignup).toHaveBeenCalledWith(
      expect.objectContaining({ termsVersion: 1 }),
    );
  });

  it('propagates API errors to the caller', async () => {
    mockSignup.mockRejectedValue(new Error('invite invalid'));

    await expect(
      signupUser('x', 'y', 'x@y.com', 'BAD'),
    ).rejects.toThrow('invite invalid');
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  it('calls generateInitialKeys and uploadInitialPreKeyBundle after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'frank',
      email: 'f@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('frank', 'pass', 'f@x.com', 'CODE');

    expect(mockGenerateInitialKeys).toHaveBeenCalledTimes(1);
    expect(mockUploadInitialPreKeyBundle).toHaveBeenCalledTimes(1);
  });

  it('loads DM conversations after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'frank',
      email: 'f@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('frank', 'pass', 'f@x.com', 'CODE');

    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });

  it('calls fulfillPendingWraps after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'frank',
      email: 'f@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('frank', 'pass', 'f@x.com', 'CODE');

    expect(mockFulfillPendingWraps).toHaveBeenCalled();
  });

  it('hydrates contacts from orbits after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'frank',
      email: 'f@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('frank', 'pass', 'f@x.com', 'CODE');

    expect(mockHydrateContactsFromOrbits).toHaveBeenCalledTimes(1);
  });

  it('does not throw if key generation fails after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'grace',
      email: 'g@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });
    mockGenerateInitialKeys.mockRejectedValue(new Error('FFI crash'));

    await expect(
      signupUser('grace', 'pass', 'g@x.com', 'CODE'),
    ).resolves.not.toThrow();
    expect(mockSetUser).toHaveBeenCalled();
  });

  it('decrypts v2 invite group key when inviteEncryptedGroupKey is present', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'hank',
      email: 'h@x.com',
      groupId: 'group-abc',
      inviteEncryptedGroupKey: 'encrypted-blob-base64',
    });

    await signupUser('hank', 'pass', 'h@x.com', 'ABCD-EFGH-JKMN-PQRS-TVW0');

    expect(mockStripInviteCode).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS-TVW0');
    expect(mockDecryptGroupKeyFromInvite).toHaveBeenCalledWith(
      'encrypted-blob-base64',
      'ABCDEFGHJKMNPQRSTVW0',
      'group-abc',
    );
    expect(mockPersistGroupKey).toHaveBeenCalledWith('group-abc', 'base64-key');
  });

  it('does not decrypt when inviteEncryptedGroupKey is null', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'ivy',
      email: 'i@x.com',
      groupId: 'group-abc',
      inviteEncryptedGroupKey: null,
    });

    await signupUser('ivy', 'pass', 'i@x.com', 'SOMECODE');

    expect(mockDecryptGroupKeyFromInvite).not.toHaveBeenCalled();
    expect(mockPersistGroupKey).not.toHaveBeenCalled();
  });

  it('does not throw when v2 invite key decryption fails (async fallback)', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'jack',
      email: 'j@x.com',
      groupId: 'group-xyz',
      inviteEncryptedGroupKey: 'bad-blob',
    });
    mockDecryptGroupKeyFromInvite.mockImplementationOnce(() => {
      throw new Error('decryption failed');
    });

    await expect(
      signupUser('jack', 'pass', 'j@x.com', 'BADCODE12345678901234'),
    ).resolves.not.toThrow();

    expect(mockDecryptGroupKeyFromInvite).toHaveBeenCalled();
    expect(mockPersistGroupKey).not.toHaveBeenCalled();
    // postAuthBootstrap should still run
    expect(mockLoadConversations).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restoreSession
// ---------------------------------------------------------------------------

describe('restoreSession', () => {
  it('returns false immediately when no access token is stored', async () => {
    mockGetAccessToken.mockResolvedValue(null);

    const result = await restoreSession();

    expect(result).toBe(false);
    expect(mockVerifyToken).not.toHaveBeenCalled();
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it('returns true and populates store when token is valid', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarPath: null,
    });
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it('fires ensureKeysInitialized after successful session restore', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    await restoreSession();

    expect(mockEnsureKeysInitialized).toHaveBeenCalledTimes(1);
  });

  it('loads DM conversations after successful session restore', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    await restoreSession();

    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });

  it('hydrates contacts from orbits after successful session restore', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    await restoreSession();

    expect(mockHydrateContactsFromOrbits).toHaveBeenCalledTimes(1);
  });

  it('clears tokens and returns false on AuthError', async () => {
    mockGetAccessToken.mockResolvedValue('expired-token');
    mockVerifyToken.mockRejectedValue(new AuthError(401, 'expired'));

    const result = await restoreSession();

    expect(result).toBe(false);
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  it('re-throws NetworkError so the caller can handle retry', async () => {
    mockGetAccessToken.mockResolvedValue('some-token');
    mockVerifyToken.mockRejectedValue(new NetworkError('timeout'));

    await expect(restoreSession()).rejects.toBeInstanceOf(NetworkError);
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it('clears tokens and returns false on generic error', async () => {
    mockGetAccessToken.mockResolvedValue('some-token');
    mockVerifyToken.mockRejectedValue(new Error('unexpected'));

    const result = await restoreSession();

    expect(result).toBe(false);
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  it('hydrates needsTermsAcceptance=true from verifyToken response', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({
      userId: 'u1',
      username: 'eve',
      needsTermsAcceptance: true,
    });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(true);
  });

  it('hydrates needsTermsAcceptance=false from verifyToken response', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({
      userId: 'u1',
      username: 'eve',
      needsTermsAcceptance: false,
    });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
  });

  it('defaults needsTermsAcceptance to false when absent in verifyToken (backward compat)', async () => {
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({
      userId: 'u1',
      username: 'eve',
    });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// acceptCurrentTerms
// ---------------------------------------------------------------------------

describe('acceptCurrentTerms', () => {
  it('calls acceptTerms API and clears the flag on success', async () => {
    await acceptCurrentTerms();

    expect(mockAcceptTerms).toHaveBeenCalledTimes(1);
    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
  });

  it('does not clear the flag when acceptTerms rejects', async () => {
    mockAcceptTerms.mockRejectedValueOnce(new Error('server error'));

    await expect(acceptCurrentTerms()).rejects.toThrow('server error');
    expect(mockSetNeedsTermsAcceptance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  it('clears tokens, clears auth state, and resets domain slices', async () => {
    await logout();

    expect(mockClearTokens).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
    expect(mockSetConversations).toHaveBeenCalledWith([]);
    expect(mockSetContacts).toHaveBeenCalledWith([]);
  });

  it('clears per-session crypto state on logout (preserves identity)', async () => {
    await logout();

    expect(mockClearGroupKeyCache).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith('DELETE FROM signal_sessions');
    expect(mockExecute).toHaveBeenCalledWith('DELETE FROM signal_sender_keys');
    // Identity keys, pre-keys, and items are PRESERVED for same-user re-login
    expect(mockExecute).not.toHaveBeenCalledWith('DELETE FROM items');
    expect(mockExecute).not.toHaveBeenCalledWith('DELETE FROM signal_pre_keys');
    expect(mockExecute).not.toHaveBeenCalledWith('DELETE FROM signal_identity_keys');
  });

  it('does not throw if MMKV clearAll fails', async () => {
    // This test verifies the try/catch inside logout() is safe
    const { getMMKVInstance } = require('../../stores/middleware/persistence');
    (getMMKVInstance as jest.Mock).mockImplementationOnce(() => {
      throw new Error('MMKV not initialized');
    });

    await expect(logout()).resolves.not.toThrow();
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  it('does NOT call fullCryptoWipe or unlink the DB file (logout preserves identity)', async () => {
    await logout();

    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockClearSecureStorage).not.toHaveBeenCalled();
    expect(mockCloseDatabase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

describe('deleteAccount', () => {
  beforeEach(() => {
    mockDeleteAccountApi.mockResolvedValue(undefined);
  });

  it('on success: calls users.deleteAccount, performs full wipe, returns success', async () => {
    const result = await deleteAccount('mypassword');

    expect(result).toEqual({ status: 'success' });
    expect(mockDeleteAccountApi).toHaveBeenCalledWith('user-1', 'mypassword');
    expect(mockWsDisconnect).toHaveBeenCalled();
    expect(mockFullCryptoWipe).toHaveBeenCalled();
    expect(mockCloseDatabase).toHaveBeenCalled();
    expect(mockClearSecureStorage).toHaveBeenCalled();
  });

  it('on success: DB unlink happens BEFORE clearSecureStorage (critical ordering)', async () => {
    const result = await deleteAccount('pw');

    expect(result).toEqual({ status: 'success' });

    // Find the call that unlinks orbital.db
    const dbUnlinkIndex = mockUnlink.mock.calls.findIndex(
      (c: unknown[]) => c[0] === `${MOCK_DOC_DIR}/orbital.db`,
    );
    expect(dbUnlinkIndex).toBeGreaterThanOrEqual(0);

    // clearSecureStorage must have been called after that unlink
    const dbUnlinkOrder = mockUnlink.mock.invocationCallOrder[dbUnlinkIndex];
    const clearSecureOrder = mockClearSecureStorage.mock.invocationCallOrder[0];
    expect(dbUnlinkOrder).toBeLessThan(clearSecureOrder);
  });

  it('on API 403: returns incorrect_password and performs NO wipe', async () => {
    mockDeleteAccountApi.mockRejectedValue(new AuthError(403, 'bad password'));

    const result = await deleteAccount('wrong');

    expect(result).toEqual({ status: 'incorrect_password' });
    // No wipe operations called
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockClearSecureStorage).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockCloseDatabase).not.toHaveBeenCalled();
    // Tokens NOT cleared (user remains logged in)
    expect(mockClearTokens).not.toHaveBeenCalled();
    // WS reconnected
    expect(mockWsConnect).toHaveBeenCalled();
  });

  it('on API 409 (ConflictError): returns blocking_orbits with authoritative list and performs NO wipe', async () => {
    const rawBody = JSON.stringify({
      error: 'Cannot delete account',
      details: {
        blocking_orbits: [
          { id: 'orbit-1', encrypted_name: 'enc-name-1' },
          { id: 'orbit-2', encrypted_name: 'enc-name-2' },
        ],
      },
    });
    mockDeleteAccountApi.mockRejectedValue(new ConflictError(rawBody));

    const result = await deleteAccount('pw');

    expect(result).toEqual({
      status: 'blocking_orbits',
      blockingOrbits: [
        { id: 'orbit-1', encryptedName: 'enc-name-1' },
        { id: 'orbit-2', encryptedName: 'enc-name-2' },
      ],
    });
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockClearSecureStorage).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockCloseDatabase).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
    expect(mockWsConnect).toHaveBeenCalled();
  });

  it('on NetworkError: returns error and performs NO wipe', async () => {
    mockDeleteAccountApi.mockRejectedValue(new NetworkError('timeout'));

    const result = await deleteAccount('pw');

    expect(result).toEqual({
      status: 'error',
      message: 'Network error — please check your connection',
    });
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockClearSecureStorage).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
    expect(mockWsConnect).toHaveBeenCalled();
  });

  it('returns error when userId is null (not authenticated)', async () => {
    const { useAppStore } = require('../../stores/useAppStore');
    (useAppStore.getState as jest.Mock).mockReturnValueOnce({
      userId: null,
      setUser: mockSetUser,
      clearAuth: mockClearAuth,
      setConversations: mockSetConversations,
      setContacts: mockSetContacts,
    });

    const result = await deleteAccount('pw');

    expect(result).toEqual({ status: 'error', message: 'Not authenticated' });
    expect(mockDeleteAccountApi).not.toHaveBeenCalled();
  });

  it('on success: asserts clearTokens AND clearAuth are called (navigation mechanism)', async () => {
    const result = await deleteAccount('pw');

    expect(result).toEqual({ status: 'success' });
    expect(mockClearTokens).toHaveBeenCalled();
    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('on success: media files and chunk cache files are unlinked', async () => {
    // Set up FS mocks so media dir exists with files
    mockExists.mockImplementation(async (path: string) => {
      if (path === `${MOCK_DOC_DIR}/media`) return true;
      return false;
    });
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === `${MOCK_DOC_DIR}/media`) {
        return [{ path: `${MOCK_DOC_DIR}/media/photo.jpg`, name: 'photo.jpg' }];
      }
      // CachesDirectoryPath readDir
      if (path === '/mock/caches') {
        return [{ path: '/mock/caches/abc-chunk-0.bin', name: 'abc-chunk-0.bin' }];
      }
      return [];
    });

    const result = await deleteAccount('pw');

    expect(result).toEqual({ status: 'success' });
    // Media file should be unlinked
    expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DOC_DIR}/media/photo.jpg`);
    // Chunk cache file should be unlinked
    expect(mockUnlink).toHaveBeenCalledWith('/mock/caches/abc-chunk-0.bin');
  });

  it('mid-wipe failure (fullCryptoWipe rejects): still returns success and runs clearTokens + closeDatabase + DB unlink', async () => {
    mockFullCryptoWipe.mockRejectedValueOnce(new Error('crypto wipe exploded'));

    const result = await deleteAccount('pw');

    expect(result).toEqual({ status: 'success' });
    // clearTokens must have been called (either in localWipe Phase 1 or fallback)
    expect(mockClearTokens).toHaveBeenCalled();
    // closeDatabase should still run after fullCryptoWipe fails
    expect(mockCloseDatabase).toHaveBeenCalled();
    // DB file unlink should still happen
    expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DOC_DIR}/orbital.db`);
  });
});

// ---------------------------------------------------------------------------
// Account-switch refusal guard
// ---------------------------------------------------------------------------

describe('checkAccountSwitch', () => {
  it('passes when DB is not initialized (fresh device)', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    expect(() => checkAccountSwitch('any-user')).not.toThrow();
    // Should not attempt to read/write items when DB is uninitialized
    expect(mockGetItem).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('passes and writes lastUserId when no lastUserId exists (fresh device with DB)', () => {
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockGetItem.mockReturnValue(null);
    expect(() => checkAccountSwitch('user-1')).not.toThrow();
    expect(mockSetItem).toHaveBeenCalledWith('lastUserId', 'user-1');
  });

  it('passes when same user logs in', () => {
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockGetItem.mockReturnValue('user-1');
    expect(() => checkAccountSwitch('user-1')).not.toThrow();
    expect(mockSetItem).toHaveBeenCalledWith('lastUserId', 'user-1');
  });

  it('throws AccountSwitchError when a different user tries', () => {
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockGetItem.mockReturnValue('user-1');
    expect(() => checkAccountSwitch('user-2')).toThrow(AccountSwitchError);
    // lastUserId must NOT be overwritten
    expect(mockSetItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Account-switch refusal — loginUser
// ---------------------------------------------------------------------------

describe('loginUser account-switch refusal', () => {
  it('same user: login succeeds, tokens stored, store populated', async () => {
    mockGetItem.mockReturnValue('user-1');
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'user-1',
      username: 'alice',
      publicKey: null,
    });

    await loginUser('alice', 'secret');

    expect(mockSetTokens).toHaveBeenCalledWith('tok', undefined);
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('different user: throws AccountSwitchError, setTokens NOT called, store untouched, lastUserId unchanged', async () => {
    mockGetItem.mockReturnValue('original-user');
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'intruder',
      username: 'eve',
      publicKey: null,
    });

    await expect(loginUser('eve', 'pass')).rejects.toBeInstanceOf(AccountSwitchError);
    expect(mockSetTokens).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    // lastUserId not overwritten
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('fresh device (no lastUserId): login succeeds', async () => {
    mockGetItem.mockReturnValue(null);
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'new-user',
      username: 'newbie',
      publicKey: null,
    });

    await loginUser('newbie', 'pass');

    expect(mockSetTokens).toHaveBeenCalled();
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith('lastUserId', 'new-user');
  });

  it('DB uninitialized: login succeeds (no guard)', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'any-user',
      username: 'any',
      publicKey: null,
    });

    await loginUser('any', 'pass');

    expect(mockSetTokens).toHaveBeenCalled();
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockGetItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Account-switch refusal — signupUser
// ---------------------------------------------------------------------------

describe('signupUser account-switch refusal', () => {
  it('same user: signup succeeds', async () => {
    mockGetItem.mockReturnValue('user-1');
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'user-1',
      username: 'alice',
      email: 'a@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('alice', 'pass', 'a@x.com', 'CODE');

    expect(mockSetTokens).toHaveBeenCalled();
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('different user: throws AccountSwitchError, setTokens NOT called, store untouched, lastUserId unchanged', async () => {
    mockGetItem.mockReturnValue('original-user');
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'intruder',
      username: 'eve',
      email: 'e@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await expect(signupUser('eve', 'pass', 'e@x.com', 'CODE')).rejects.toBeInstanceOf(AccountSwitchError);
    expect(mockSetTokens).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('fresh device (no lastUserId): signup succeeds', async () => {
    mockGetItem.mockReturnValue(null);
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'new-user',
      username: 'newbie',
      email: 'n@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('newbie', 'pass', 'n@x.com', 'CODE');

    expect(mockSetTokens).toHaveBeenCalled();
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith('lastUserId', 'new-user');
  });

  it('DB uninitialized: signup succeeds (no guard)', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'any-user',
      username: 'any',
      email: 'a@x.com',
      groupId: null,
      inviteEncryptedGroupKey: null,
    });

    await signupUser('any', 'pass', 'a@x.com', 'CODE');

    expect(mockSetTokens).toHaveBeenCalled();
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockGetItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Account-switch refusal — restoreSession
// ---------------------------------------------------------------------------

describe('restoreSession account-switch refusal', () => {
  it('same user: restores successfully', async () => {
    mockGetItem.mockReturnValue('u1');
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('different user: clears tokens, returns false, no wipe, store untouched', async () => {
    mockGetItem.mockReturnValue('original-user');
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'intruder' });
    mockGetMe.mockResolvedValue({
      id: 'intruder-id',
      username: 'intruder',
      displayName: 'Intruder',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(false);
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
    // Store must never be hydrated — setUser triggers isAuthenticated:true
    expect(mockSetUser).not.toHaveBeenCalled();
    expect(mockSetNeedsTermsAcceptance).not.toHaveBeenCalled();
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    // lastUserId must NOT be overwritten
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('fresh device (no lastUserId): restores successfully', async () => {
    mockGetItem.mockReturnValue(null);
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockSetItem).toHaveBeenCalledWith('lastUserId', 'u1');
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('DB uninitialized: restores successfully (no guard)', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockGetAccessToken.mockResolvedValue('stored-token');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1', username: 'eve' });
    mockGetMe.mockResolvedValue({
      id: 'u1',
      username: 'eve',
      displayName: 'Eve',
      avatarUrl: null,
      createdAt: '2024-01-01',
    });

    const result = await restoreSession();

    expect(result).toBe(true);
    expect(mockGetItem).not.toHaveBeenCalled();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Invariant: fullCryptoWipe is NEVER called from login/signup/restore
// ---------------------------------------------------------------------------

describe('fullCryptoWipe invariant', () => {
  it('loginUser never calls fullCryptoWipe (same user)', async () => {
    mockGetItem.mockReturnValue('user-1');
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'a', publicKey: null,
    });
    await loginUser('a', 'p');
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('loginUser never calls fullCryptoWipe (different user — throws instead)', async () => {
    mockGetItem.mockReturnValue('original');
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'other', username: 'b', publicKey: null,
    });
    await expect(loginUser('b', 'p')).rejects.toBeInstanceOf(AccountSwitchError);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('signupUser never calls fullCryptoWipe (same user)', async () => {
    mockGetItem.mockReturnValue('user-1');
    mockSignup.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'a', email: 'a@x.com',
      groupId: null, inviteEncryptedGroupKey: null,
    });
    await signupUser('a', 'p', 'a@x.com', 'C');
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('signupUser never calls fullCryptoWipe (different user — throws instead)', async () => {
    mockGetItem.mockReturnValue('original');
    mockSignup.mockResolvedValue({
      token: 'tok', userId: 'other', username: 'b', email: 'b@x.com',
      groupId: null, inviteEncryptedGroupKey: null,
    });
    await expect(signupUser('b', 'p', 'b@x.com', 'C')).rejects.toBeInstanceOf(AccountSwitchError);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('restoreSession never calls fullCryptoWipe (same user)', async () => {
    mockGetItem.mockReturnValue('u1');
    mockGetAccessToken.mockResolvedValue('tok');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1' });
    mockGetMe.mockResolvedValue({ id: 'u1', username: 'a', displayName: 'A', avatarUrl: null });
    await restoreSession();
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });

  it('restoreSession never calls fullCryptoWipe (different user — clears tokens instead)', async () => {
    mockGetItem.mockReturnValue('original');
    mockGetAccessToken.mockResolvedValue('tok');
    mockVerifyToken.mockResolvedValue({ valid: true, userId: 'u1' });
    mockGetMe.mockResolvedValue({ id: 'other', username: 'b', displayName: 'B', avatarUrl: null });
    const result = await restoreSession();
    expect(result).toBe(false);
    expect(mockFullCryptoWipe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ConflictError detection — sets identityKeyConflict flag
// ---------------------------------------------------------------------------

describe('ConflictError detection', () => {
  it('postAuthBootstrap sets identityKeyConflict when ensureKeysInitialized throws ConflictError (login path)', async () => {
    mockEnsureKeysInitialized.mockRejectedValueOnce(new ConflictError());
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', publicKey: null,
    });

    await loginUser('alice@test.com', 'secret');

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('local');
  });

  it('signupUser sets identityKeyConflict when key upload throws ConflictError', async () => {
    mockUploadInitialPreKeyBundle.mockRejectedValueOnce(new ConflictError());
    mockSignup.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', email: 'a@x.com',
      groupId: null, inviteEncryptedGroupKey: null,
    });

    await signupUser('alice', 'pass', 'a@x.com', 'CODE');

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('local');
  });
});

// ---------------------------------------------------------------------------
// Email persistence from INPUT parameter
// ---------------------------------------------------------------------------

describe('email persistence', () => {
  it('loginUser persists email from INPUT parameter', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', publicKey: null,
    });

    await loginUser('alice@example.com', 'secret');

    expect(mockSetEmail).toHaveBeenCalledWith('alice@example.com');
  });

  it('signupUser persists email from INPUT parameter', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok', userId: 'user-1', username: 'alice', email: 'a@x.com',
      groupId: null, inviteEncryptedGroupKey: null,
    });

    await signupUser('alice', 'pass', 'signup@example.com', 'CODE');

    expect(mockSetEmail).toHaveBeenCalledWith('signup@example.com');
  });
});

// ---------------------------------------------------------------------------
// loginForRecovery
// ---------------------------------------------------------------------------

describe('loginForRecovery', () => {
  it('calls login API, sets tokens, sets user, but does NOT call postAuthBootstrap', async () => {
    mockLogin.mockResolvedValue({
      token: 'recovery-tok',
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      publicKey: null,
      needsTermsAcceptance: false,
    });

    await loginForRecovery('alice@example.com', 'password');

    expect(mockLogin).toHaveBeenCalledWith({ email: 'alice@example.com', password: 'password' });
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(false);
    expect(mockSetEmail).toHaveBeenCalledWith('alice@example.com');
    // postAuthBootstrap indicators should NOT have been called
    expect(mockEnsureKeysInitialized).not.toHaveBeenCalled();
    expect(mockLoadConversations).not.toHaveBeenCalled();
  });

  it('propagates needsTermsAcceptance from response (API-M1)', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'user-1',
      username: 'alice',
      displayName: null,
      publicKey: null,
      needsTermsAcceptance: true,
    });

    await loginForRecovery('alice@example.com', 'password');

    expect(mockSetNeedsTermsAcceptance).toHaveBeenCalledWith(true);
  });
});
