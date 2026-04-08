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
    onTokensCleared: undefined,
  },
}));

// Mock the MMKV module used via require() inside logout()
jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: jest.fn(() => ({ clearAll: jest.fn() })),
}));

// Mock the whole store module — we just want to verify action calls
const mockSetUser = jest.fn();
const mockClearAuth = jest.fn();
const mockSetConversations = jest.fn();
const mockSetContacts = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setUser: mockSetUser,
      clearAuth: mockClearAuth,
      setConversations: mockSetConversations,
      setContacts: mockSetContacts,
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
      refreshToken: 'refresh-456',
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://example.com/alice.jpg',
    });

    await loginUser('alice', 'secret');

    expect(mockLogin).toHaveBeenCalledWith({ username: 'alice', password: 'secret' });
    expect(mockSetTokens).toHaveBeenCalledWith('access-123', 'refresh-456');
    expect(mockSetUser).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarPath: 'https://example.com/alice.jpg',
    });
  });

  it('maps API avatarUrl to store avatarPath field', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'bob',
      displayName: null,
      avatarUrl: '/uploads/bob.jpg',
    });

    await loginUser('bob', 'pass');

    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({ avatarPath: '/uploads/bob.jpg' }),
    );
  });

  it('maps null avatarUrl to null avatarPath', async () => {
    mockLogin.mockResolvedValue({
      token: 'tok',
      userId: 'u1',
      username: 'carol',
      displayName: null,
      avatarUrl: null,
    });

    await loginUser('carol', 'pass');

    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({ avatarPath: null }),
    );
  });

  it('propagates API errors to the caller', async () => {
    mockLogin.mockRejectedValue(new AuthError(401, 'bad creds'));

    await expect(loginUser('bad', 'creds')).rejects.toBeInstanceOf(AuthError);
    expect(mockSetTokens).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// signupUser
// ---------------------------------------------------------------------------

describe('signupUser', () => {
  it('calls signup API, stores tokens, and populates store with null displayName/avatarPath', async () => {
    mockSignup.mockResolvedValue({
      token: 'access-abc',
      refreshToken: 'refresh-def',
      userId: 'user-2',
      username: 'dave',
    });

    await signupUser('dave', 'password', 'dave@example.com', 'INV-CODE');

    expect(mockSignup).toHaveBeenCalledWith({
      username: 'dave',
      password: 'password',
      email: 'dave@example.com',
      inviteCode: 'INV-CODE',
    });
    expect(mockSetTokens).toHaveBeenCalledWith('access-abc', 'refresh-def');
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
