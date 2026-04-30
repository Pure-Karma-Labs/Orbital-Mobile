/**
 * Tests for the invites API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import {
  generateInvite,
  generateInviteLink,
  getInviteStatus,
  getGroupInvites,
} from '../invites';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('generateInvite', () => {
  it('calls POST /api/invites/generate with groupId and targetEmail', async () => {
    const data = { groupId: 'group-1', targetEmail: 'alice@example.com' };
    await generateInvite(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/invites/generate',
      body: data,
    });
  });
});

describe('generateInviteLink', () => {
  it('calls POST /api/invites/generate-link with groupId and targetEmail', async () => {
    const data = { groupId: 'group-1', targetEmail: 'bob@example.com' };
    await generateInviteLink(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/invites/generate-link',
      body: data,
    });
  });
});

describe('getInviteStatus', () => {
  it('calls GET /api/invites/status/:code', async () => {
    await getInviteStatus('INV-001');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/invites/status/INV-001',
    });
  });

  it('encodes special characters in invite code', async () => {
    await getInviteStatus('code/special');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/invites/status/code%2Fspecial',
      }),
    );
  });
});

describe('getGroupInvites', () => {
  it('calls GET /api/invites/group/:groupId', async () => {
    await getGroupInvites('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/invites/group/group-1',
    });
  });

  it('encodes special characters in groupId', async () => {
    await getGroupInvites('group/special');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/invites/group/group%2Fspecial',
      }),
    );
  });
});
