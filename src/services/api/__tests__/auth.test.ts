/**
 * Tests for the auth API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { login, signup, verifyToken, getPublicKey } from '../auth';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('login', () => {
  it('calls POST /api/login with correct body', async () => {
    const data = { username: 'alice', password: 's3cret' };
    await login(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/login',
      body: data,
      skipAuth: true,
    });
  });
});

describe('signup', () => {
  it('calls POST /api/signup with correct body', async () => {
    const data = {
      username: 'bob',
      password: 'pass123',
      email: 'bob@example.com',
      inviteCode: 'INV-001',
    };
    await signup(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/signup',
      body: data,
      skipAuth: true,
    });
  });
});

describe('verifyToken', () => {
  it('calls POST /api/verify-token with auth (no skipAuth)', async () => {
    await verifyToken();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/verify-token',
    });
    // Critically: skipAuth must NOT be present (or must be falsy)
    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('skipAuth', true);
  });
});

describe('getPublicKey', () => {
  it('calls GET /api/users/:username/public-key with skipAuth', async () => {
    await getPublicKey('alice');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/users/alice/public-key',
      skipAuth: true,
    });
  });

  it('encodes special characters in username', async () => {
    await getPublicKey('user name');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/users/user%20name/public-key',
      }),
    );
  });
});
