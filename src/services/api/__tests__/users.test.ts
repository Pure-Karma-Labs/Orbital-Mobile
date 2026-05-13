/**
 * Tests for the users API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { getMe, updateDisplayName, uploadAvatar, deleteAvatar } from '../users';

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

describe('updateDisplayName', () => {
  it('calls PUT /api/users/display-name with the display name', async () => {
    mockRequest.mockResolvedValue({ displayName: 'Alice', updatedAt: '2026-05-13T00:00:00Z' });

    await updateDisplayName('Alice');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/display-name',
      body: { displayName: 'Alice' },
    });
  });
});

describe('uploadAvatar', () => {
  it('calls POST /api/users/avatar with FormData', async () => {
    mockRequest.mockResolvedValue({ avatarUrl: '/avatars/abc.jpg', updatedAt: '2026-05-13T00:00:00Z' });

    const formData = new FormData();
    formData.append('avatar', 'file-data');

    await uploadAvatar(formData);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/users/avatar',
      body: formData,
    });
  });
});

describe('deleteAvatar', () => {
  it('calls DELETE /api/users/avatar', async () => {
    await deleteAvatar();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/users/avatar',
    });
  });
});

