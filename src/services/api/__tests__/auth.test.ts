/**
 * Tests for the auth API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import {
  login,
  signup,
  verifyToken,
  forgotPassword,
  resetPasswordWithCode,
} from '../auth';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('login', () => {
  it('calls POST /api/login with correct body', async () => {
    const data = { email: 'alice@example.com', password: 's3cret' };
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

describe('forgotPassword', () => {
  it('calls POST /api/forgot-password with correct body and skipAuth', async () => {
    await forgotPassword('alice@example.com');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/forgot-password',
      body: { email: 'alice@example.com' },
      skipAuth: true,
    });
  });
});

describe('resetPasswordWithCode', () => {
  it('calls POST /api/reset-password-with-code with all fields and skipAuth', async () => {
    await resetPasswordWithCode('alice@example.com', 'ABCD1234', 'newS3cret!');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/reset-password-with-code',
      body: {
        email: 'alice@example.com',
        code: 'ABCD1234',
        newPassword: 'newS3cret!',
      },
      skipAuth: true,
    });
  });
});
