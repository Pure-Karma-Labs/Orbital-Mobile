/**
 * Tests for the users API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { getMe } from '../users';

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

