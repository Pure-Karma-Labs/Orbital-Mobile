/**
 * Tests for the users API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { getMe, getUser, uploadAvatar, deleteAvatar, updateDisplayName } from '../users';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('getMe', () => {
  it('calls GET /api/users/me', async () => {
    await getMe();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/users/me',
    });
  });
});

describe('getUser', () => {
  it('calls GET /api/users/:userId', async () => {
    await getUser('user-123');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/users/user-123',
    });
  });

  it('encodes special characters in userId', async () => {
    await getUser('user name');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/users/user%20name',
      }),
    );
  });
});

describe('uploadAvatar', () => {
  it('calls POST /api/users/avatar with FormData body and 60s timeout', async () => {
    const formData = new FormData();
    formData.append('avatar', 'data');

    await uploadAvatar(formData);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/users/avatar',
      body: formData,
      timeout: 60_000,
    });
  });
});

describe('deleteAvatar', () => {
  it('calls DELETE /api/users/avatar with no body', async () => {
    await deleteAvatar();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/users/avatar',
    });
  });

  it('does not include a body', async () => {
    await deleteAvatar();

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('body');
  });
});

describe('updateDisplayName', () => {
  it('calls PUT /api/users/display-name with correct body', async () => {
    const data = { displayName: 'Alice' };
    await updateDisplayName(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/display-name',
      body: data,
    });
  });
});
