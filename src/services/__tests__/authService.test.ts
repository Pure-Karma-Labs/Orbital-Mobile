/**
 * Tests for authService — login, signup, session restore, logout orchestration.
 */

import { loginUser, signupUser, restoreSession, logout } from '../authService';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../api/auth', () => ({
  login: jest.fn(),
  signup: jest.fn(),
  verifyToken: jest.fn(),
}));

jest.mock('../api/users', () => ({
  getMe: jest.fn(),
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
jest.mock('../crypto/contentCrypto', () => ({
  clearGroupKeyCache: () => mockClearGroupKeyCache(),
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

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
}));

const mockLoadConversations = jest.fn().mockResolvedValue(undefined);
const mockLoadDmConversations = jest.fn().mockResolvedValue(undefined);
const mockFulfillPendingWraps = jest.fn().mockResolvedValue(undefined);
jest.mock('../conversationService', () => ({
  loadConversations: (...args: unknown[]) => mockLoadConversations(...args),
  loadDmConversations: (...args: unknown[]) => mockLoadDmConversations(...args),
  fulfillPendingWraps: (...args: unknown[]) => mockFulfillPendingWraps(...args),
}));

jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: jest.fn(() => ({ clearAll: jest.fn() })),
}));

jest.mock('../websocket', () => ({
  websocketManager: {
    connect: jest.fn(),
    disconnect: jest.fn(),
  },
}));

// Mock the whole store module — we just want to verify action calls
const mockSetUser = jest.fn();
const mockClearAuth = jest.fn();
const mockSetConversations = jest.fn();
const mockSetContacts = jest.fn();
const mockSetConnectionStatus = jest.fn();
const mockClearTypingUsers = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setUser: mockSetUser,
      clearAuth: mockClearAuth,
      setConversations: mockSetConversations,
      setContacts: mockSetContacts,
      setConnectionStatus: mockSetConnectionStatus,
      clearTypingUsers: mockClearTypingUsers,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Import mocked modules for assertion
// ---------------------------------------------------------------------------

import * as authApi from '../api/auth';
import * as usersApi from '../api/users';
import { tokenManager } from '../api/tokenManager';
import { NetworkError, AuthError } from '../api/errors';

const mockLogin = authApi.login as jest.Mock;
const mockSignup = authApi.signup as jest.Mock;
const mockVerifyToken = authApi.verifyToken as jest.Mock;
const mockGetMe = usersApi.getMe as jest.Mock;
const mockGetAccessToken = tokenManager.getAccessToken as jest.Mock;
const mockSetTokens = tokenManager.setTokens as jest.Mock;
const mockClearTokens = tokenManager.clearTokens as jest.Mock;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
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

    expect(mockLogin).toHaveBeenCalledWith({ username: 'alice', password: 'secret' });
    expect(mockSetTokens).toHaveBeenCalledWith('access-123', undefined);
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice',
      displayName: null,
      avatarPath: null,
    });
  });

  it('sets null displayName and avatarPath since login does not return them', async () => {
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
    });

    await signupUser('dave', 'password', 'dave@example.com', 'INV-CODE');

    expect(mockSignup).toHaveBeenCalledWith({
      username: 'dave',
      password: 'password',
      email: 'dave@example.com',
      inviteCode: 'INV-CODE',
      publicKey: { type: 'placeholder' },
    });
    expect(mockSetTokens).toHaveBeenCalledWith('access-abc', undefined);
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'user-2',
      username: 'dave',
      displayName: null,
      avatarPath: null,
    });
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
    });

    await signupUser('frank', 'pass', 'f@x.com', 'CODE');

    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });

  it('does not throw if key generation fails after signup', async () => {
    mockSignup.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'grace',
      email: 'g@x.com',
      groupId: null,
    });
    mockGenerateInitialKeys.mockRejectedValue(new Error('FFI crash'));

    await expect(
      signupUser('grace', 'pass', 'g@x.com', 'CODE'),
    ).resolves.not.toThrow();
    expect(mockSetUser).toHaveBeenCalled();
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
});
