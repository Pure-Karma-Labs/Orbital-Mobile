/**
 * Tests for the groups API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import {
  createGroup,
  joinGroup,
  listGroups,
  getGroupMembers,
  getGroupKey,
  getGroupQuota,
  removeMember,
  createDm,
  listDms,
} from '../groups';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('createGroup', () => {
  it('calls POST /api/groups with correct body', async () => {
    const data = { encryptedName: 'abc123', encryptedGroupKey: 'key456' };
    await createGroup(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups',
      body: data,
    });
  });
});

describe('joinGroup', () => {
  it('calls POST /api/groups/join with invite code', async () => {
    const data = { inviteCode: 'INV-ABC', encryptedGroupKey: 'enc-key' };
    await joinGroup(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/join',
      body: data,
    });
  });
});

describe('listGroups', () => {
  it('calls GET /api/groups and unwraps the groups array', async () => {
    mockRequest.mockResolvedValue({ groups: [{ groupId: 'g1' }] });
    const result = await listGroups();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups',
    });
    expect(result).toEqual([{ groupId: 'g1' }]);
  });
});

describe('getGroupMembers', () => {
  it('calls GET /api/groups/:groupId/members', async () => {
    await getGroupMembers('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-1/members',
    });
  });

  it('encodes special characters in groupId', async () => {
    await getGroupMembers('group/special');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/group%2Fspecial/members',
      }),
    );
  });
});

describe('getGroupKey', () => {
  it('calls GET /api/groups/:groupId/key', async () => {
    await getGroupKey('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-1/key',
    });
  });
});

describe('getGroupQuota', () => {
  it('calls GET /api/groups/:groupId/quota', async () => {
    await getGroupQuota('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-1/quota',
    });
  });
});

describe('removeMember', () => {
  it('calls DELETE /api/groups/:groupId/members/:userId', async () => {
    await removeMember('group-1', 'user-2');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/groups/group-1/members/user-2',
    });
  });

  it('encodes both URL params', async () => {
    await removeMember('group/a', 'user/b');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/group%2Fa/members/user%2Fb',
      }),
    );
  });
});

describe('createDm', () => {
  it('calls POST /api/groups/dm with recipientId', async () => {
    const data = { recipientId: 'user-99', encryptedGroupKey: 'enc-key' };
    await createDm(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/dm',
      body: data,
    });
  });
});

describe('listDms', () => {
  it('calls GET /api/groups/dms and unwraps the dms array', async () => {
    mockRequest.mockResolvedValue({ dms: [{ groupId: 'dm1' }] });
    const result = await listDms();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/dms',
    });
    expect(result).toEqual([{ groupId: 'dm1' }]);
  });
});
