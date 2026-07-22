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
  submitWrappedKey,
  selfWrapGroupKey,
  getPendingWraps,
  getGroupMembers,
  generateInviteCode,
  removeMember,
  transferOrbitOwner,
  dissolveOrbit,
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

describe('getGroupMembers', () => {
  it('calls GET /api/groups/:groupId/members and unwraps members', async () => {
    const members = [
      {
        userId: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        avatarUrl: null,
        joinedAt: '2026-05-01T00:00:00Z',
      },
    ];
    mockRequest.mockResolvedValue({ members });
    const result = await getGroupMembers('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-1/members',
    });
    expect(result).toEqual(members);
  });

  it('encodes groupId in the URL path', async () => {
    mockRequest.mockResolvedValue({ members: [] });
    await getGroupMembers('g/../admin');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/members',
      }),
    );
  });

  it('exposes lastActiveAt and isDormant from snake_case response (Backend #210 PR 2)', async () => {
    const members = [
      {
        userId: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        avatarUrl: null,
        joinedAt: '2026-05-01T00:00:00Z',
        lastActiveAt: '2026-07-20T12:00:00Z',
        isDormant: false,
      },
      {
        userId: 'user-2',
        username: 'bob',
        displayName: 'Bob',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        avatarUrl: null,
        joinedAt: '2026-05-02T00:00:00Z',
        lastActiveAt: null,
        isDormant: true,
      },
    ];
    mockRequest.mockResolvedValue({ members });
    const result = await getGroupMembers('group-1');

    expect(result[0].lastActiveAt).toBe('2026-07-20T12:00:00Z');
    expect(result[0].isDormant).toBe(false);
    expect(result[1].lastActiveAt).toBeNull();
    expect(result[1].isDormant).toBe(true);
  });
});

describe('generateInviteCode', () => {
  it('calls POST /api/groups/:groupId/invite-codes with targetEmail', async () => {
    await generateInviteCode('group-1', 'test@example.com', { code: 'ABCD1234EFGH5678JKMN', encryptedGroupKey: 'base64blob' });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/group-1/invite-codes',
      body: { targetEmail: 'test@example.com', code: 'ABCD1234EFGH5678JKMN', encryptedGroupKey: 'base64blob' },
    });
  });

  it('encodes groupId in the URL path', async () => {
    await generateInviteCode('g/../admin', 'test@example.com', { code: 'ABCD1234EFGH5678JKMN', encryptedGroupKey: 'base64blob' });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/invite-codes',
      }),
    );
  });
});

describe('removeMember', () => {
  it('calls DELETE /api/groups/:groupId/members/:userId', async () => {
    await removeMember('group-1', 'user-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/groups/group-1/members/user-1',
    });
  });

  it('encodes groupId and userId in the URL path', async () => {
    await removeMember('g/../admin', 'u/../root');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/members/u%2F..%2Froot',
      }),
    );
  });
});

describe('submitWrappedKey', () => {
  it('calls POST /api/groups/:groupId/members/:userId/wrapped-key', async () => {
    await submitWrappedKey('group-1', 'user-1', 'wrapped-key-data');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/group-1/members/user-1/wrapped-key',
      body: { wrappedGroupKey: 'wrapped-key-data' },
    });
  });

  it('encodes groupId and userId in the URL path', async () => {
    await submitWrappedKey('g/../admin', 'u/../root', 'key');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/members/u%2F..%2Froot/wrapped-key',
      }),
    );
  });
});

describe('selfWrapGroupKey', () => {
  it('calls POST /api/groups/:groupId/self-wrap with correct body', async () => {
    await selfWrapGroupKey('group-1', 'wrapped-key-data');
    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/group-1/self-wrap',
      body: { wrappedGroupKey: 'wrapped-key-data' },
    });
  });

  it('encodes groupId in the URL path', async () => {
    await selfWrapGroupKey('g/../admin', 'wrapped-key-data');
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/self-wrap',
      }),
    );
  });
});

describe('getPendingWraps', () => {
  it('calls GET /api/groups/:groupId/pending-wraps and unwraps pending', async () => {
    const pending = [
      { userId: 'user-2', identityPublicKey: 'dGVzdC1wdWJsaWMta2V5' },
    ];
    mockRequest.mockResolvedValue({ pending });
    const result = await getPendingWraps('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-1/pending-wraps',
    });
    expect(result).toEqual(pending);
  });

  it('encodes groupId in the URL path', async () => {
    mockRequest.mockResolvedValue({ pending: [] });
    await getPendingWraps('g/../admin');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/pending-wraps',
      }),
    );
  });
});

describe('transferOrbitOwner', () => {
  it('calls POST /api/groups/:groupId/transfer-owner with newOwnerId', async () => {
    mockRequest.mockResolvedValue({ success: true });
    await transferOrbitOwner('group-1', 'user-2');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/groups/group-1/transfer-owner',
      body: { newOwnerId: 'user-2' },
    });
  });

  it('encodes groupId in the URL path', async () => {
    mockRequest.mockResolvedValue({ success: true });
    await transferOrbitOwner('g/../admin', 'user-2');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin/transfer-owner',
      }),
    );
  });
});

describe('dissolveOrbit', () => {
  it('calls DELETE /api/groups/:groupId', async () => {
    mockRequest.mockResolvedValue({ success: true });
    await dissolveOrbit('group-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/groups/group-1',
    });
  });

  it('encodes groupId in the URL path', async () => {
    mockRequest.mockResolvedValue({ success: true });
    await dissolveOrbit('g/../admin');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/groups/g%2F..%2Fadmin',
      }),
    );
  });
});

