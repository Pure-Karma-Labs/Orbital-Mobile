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
  getGroupKey,
  getGroupQuota,
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
    const data = { encryptedName: 'abc123', wrappedGroupKey: 'key456' };
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
    const data = { inviteCode: 'INV-ABC' };
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

describe('createDm', () => {
  it('calls POST /api/groups/dm with correct body', async () => {
    const data = { recipientId: 'user-1', wrappedGroupKey: 'key123' };
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
    mockRequest.mockResolvedValue({
      dms: [{ groupId: 'dm-1', recipient: { id: 'u1', username: 'alice', avatarUrl: null } }],
    });
    const result = await listDms();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/dms',
    });
    expect(result).toEqual([
      { groupId: 'dm-1', recipient: { id: 'u1', username: 'alice', avatarUrl: null } },
    ]);
  });
});

