jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
  listDms: jest.fn(),
  createDm: jest.fn(),
  joinGroup: jest.fn(),
}));

const mockPersistGroupKey = jest.fn();
const mockProcessReceivedGroupKey = jest.fn().mockResolvedValue(undefined);
const mockGetOrFetchGroupKey = jest.fn().mockResolvedValue(new Uint8Array(32));
const mockDecryptGroupName = jest.fn((name: string, _key: Uint8Array) => name);
const mockGenerateGroupKey = jest.fn(() => ({
  key: new Uint8Array(32),
  keyBase64: 'generated-key-base64',
}));
const mockEncryptGroupName = jest.fn((_name: string, _key: Uint8Array) => 'encrypted-name');
const mockWrapGroupKey = jest.fn((_key: Uint8Array, _pub: ArrayBuffer, _gid: string) => 'ecies-wrapped-base64');
jest.mock('../crypto/contentCrypto', () => ({
  persistGroupKey: (...args: unknown[]) => mockPersistGroupKey(...args),
  processReceivedGroupKey: (...args: unknown[]) => mockProcessReceivedGroupKey(...args),
  getOrFetchGroupKey: (groupId: string) => mockGetOrFetchGroupKey(groupId),
  decryptGroupName: (name: string, key: Uint8Array) => mockDecryptGroupName(name, key),
  encryptGroupName: (name: string, key: Uint8Array) => mockEncryptGroupName(name, key),
  generateGroupKey: () => mockGenerateGroupKey(),
  wrapGroupKey: (key: Uint8Array, pub: ArrayBuffer, gid: string) => mockWrapGroupKey(key, pub, gid),
}));

jest.mock('../../utils/uuid', () => ({
  generateUUID: jest.fn(() => 'mock-uuid-1234'),
}));

const mockResolveRemoteIdentityKey = jest.fn().mockResolvedValue(new ArrayBuffer(33));
jest.mock('../crypto/identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(() => ({
    privateKey: new ArrayBuffer(32),
    publicKey: new ArrayBuffer(33),
  })),
  resolveRemoteIdentityKey: (...args: unknown[]) => mockResolveRemoteIdentityKey(...args),
}));

jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(32)),
}));

const mockSetConversations = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockUpsertConversation = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-self-user',
      activeConversationId: null,
      setConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
    })),
  },
}));

import { loadConversations, loadDmConversations, startDm, joinOrbit } from '../conversationService';
import { listGroups, listDms, createDm, joinGroup } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';

const mockListGroups = listGroups as jest.Mock;
const mockListDms = listDms as jest.Mock;
const mockCreateDm = createDm as jest.Mock;
const mockJoinGroup = joinGroup as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const GROUP_RESPONSE = {
  groupId: 'g1',
  encryptedName: 'Family Orbit',
  wrappedGroupKey: 'placeholder-key',
  wrappedBy: 'sender-user-1',
  memberCount: 3,
  maxMembers: 10,
  isCreator: false,
  activeInviteCode: 'TEST1234',
  joinedAt: '2026-01-01T00:00:00.000Z',
};

describe('loadConversations', () => {
  it('fetches groups and populates store', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockSetConversations).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'g1',
        name: 'Family Orbit',
        memberCount: 3,
        active: true,
      }),
    ]);
  });

  it('auto-selects first group when no active conversation', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockSetActiveConversation).toHaveBeenCalledWith('g1');
  });

  it('does not clobber existing activeConversationId', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      activeConversationId: 'existing-id',
      setConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
    });
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockSetActiveConversation).not.toHaveBeenCalled();
  });

  it('handles empty group list', async () => {
    mockListGroups.mockResolvedValue([]);

    await loadConversations();

    expect(mockSetConversations).toHaveBeenCalledWith([]);
    expect(mockSetActiveConversation).not.toHaveBeenCalled();
  });

  it('maps createdAt from ISO string to epoch ms', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    const conversation = mockSetConversations.mock.calls[0][0][0];
    expect(conversation.createdAt).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('defaults muteUntil, lastMessageAt, unreadCount', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    const conversation = mockSetConversations.mock.calls[0][0][0];
    expect(conversation.muteUntil).toBeNull();
    expect(conversation.lastMessageAt).toBeNull();
    expect(conversation.unreadCount).toBe(0);
  });

  it('processes group keys from response via processReceivedGroupKey', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockProcessReceivedGroupKey).toHaveBeenCalledWith('g1', 'placeholder-key', 'sender-user-1');
  });

  it('skips groups with null wrappedGroupKey', async () => {
    mockListGroups.mockResolvedValue([{ ...GROUP_RESPONSE, wrappedGroupKey: null }]);

    await loadConversations();

    expect(mockProcessReceivedGroupKey).not.toHaveBeenCalled();
  });

  it('continues loading when one group key fails', async () => {
    mockProcessReceivedGroupKey
      .mockRejectedValueOnce(new Error('corrupt key'))
      .mockResolvedValueOnce(undefined);
    mockListGroups.mockResolvedValue([
      GROUP_RESPONSE,
      { ...GROUP_RESPONSE, groupId: 'g2', wrappedBy: 'sender-2' },
    ]);

    await loadConversations();

    expect(mockProcessReceivedGroupKey).toHaveBeenCalledTimes(2);
    expect(mockSetConversations).toHaveBeenCalled();
  });

  it('propagates API errors', async () => {
    mockListGroups.mockRejectedValue(new Error('network'));

    await expect(loadConversations()).rejects.toThrow('network');
  });
});

// ---------------------------------------------------------------------------
// loadDmConversations
// ---------------------------------------------------------------------------

const DM_RESPONSE = {
  groupId: 'dm-1',
  recipient: { id: 'user-2', username: 'bob', avatarUrl: null },
  wrappedGroupKey: 'dm-key-base64',
  wrappedBy: 'dm-sender-1',
  lastMessageAt: '2026-03-15T12:00:00.000Z',
  createdAt: '2026-03-01T00:00:00.000Z',
};

describe('loadDmConversations', () => {
  it('fetches DMs and upserts each into the store', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await loadDmConversations();

    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dm-1',
        type: 'direct',
        name: 'bob',
        memberCount: 2,
      }),
    );
  });

  it('maps lastMessageAt from ISO string to epoch ms', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await loadDmConversations();

    const conversation = mockUpsertConversation.mock.calls[0][0];
    expect(conversation.lastMessageAt).toBe(new Date('2026-03-15T12:00:00.000Z').getTime());
  });

  it('handles null lastMessageAt', async () => {
    mockListDms.mockResolvedValue([{ ...DM_RESPONSE, lastMessageAt: null }]);

    await loadDmConversations();

    const conversation = mockUpsertConversation.mock.calls[0][0];
    expect(conversation.lastMessageAt).toBeNull();
  });

  it('processes DM group keys via processReceivedGroupKey', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await loadDmConversations();

    expect(mockProcessReceivedGroupKey).toHaveBeenCalledWith('dm-1', 'dm-key-base64', 'dm-sender-1');
  });

  it('skips DMs with null wrappedGroupKey', async () => {
    mockListDms.mockResolvedValue([{ ...DM_RESPONSE, wrappedGroupKey: null }]);

    await loadDmConversations();

    expect(mockProcessReceivedGroupKey).not.toHaveBeenCalled();
  });

  it('handles empty DM list', async () => {
    mockListDms.mockResolvedValue([]);

    await loadDmConversations();

    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startDm
// ---------------------------------------------------------------------------

describe('startDm', () => {
  it('creates a DM and returns conversationId and recipientName', async () => {
    mockCreateDm.mockResolvedValue({
      groupId: 'dm-new',
      isNew: true,
      wrappedGroupKey: 'ecies-wrapped-base64',
      recipient: { id: 'user-3', username: 'carol' },
    });

    const result = await startDm('user-3');

    expect(mockCreateDm).toHaveBeenCalledWith({
      groupId: 'mock-uuid-1234',
      recipientId: 'user-3',
      wrappedGroupKey: 'ecies-wrapped-base64',
      recipientWrappedGroupKey: 'ecies-wrapped-base64',
    });
    expect(result).toEqual({
      conversationId: 'dm-new',
      recipientName: 'carol',
    });
  });

  it('persists the group key and upserts the conversation', async () => {
    mockCreateDm.mockResolvedValue({
      groupId: 'dm-new',
      isNew: true,
      wrappedGroupKey: 'ecies-wrapped-base64',
      recipient: { id: 'user-3', username: 'carol' },
    });

    await startDm('user-3');

    expect(mockPersistGroupKey).toHaveBeenCalledWith('dm-new', 'generated-key-base64');
    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dm-new',
        type: 'direct',
        name: 'carol',
        memberCount: 2,
      }),
    );
  });

  it('accepts server key when DM already exists (isNew=false)', async () => {
    mockCreateDm.mockResolvedValue({
      groupId: 'dm-existing',
      isNew: false,
      wrappedGroupKey: 'server-existing-key',
      wrappedBy: 'other-user',
      recipient: { id: 'user-3', username: 'carol' },
    });

    await expect(startDm('user-3')).resolves.not.toThrow();
    expect(mockProcessReceivedGroupKey).toHaveBeenCalledWith('dm-existing', 'server-existing-key', 'other-user');
  });

  it('for isNew DMs trusts local key, ignoring server-returned key', async () => {
    mockCreateDm.mockResolvedValue({
      groupId: 'dm-new',
      isNew: true,
      wrappedGroupKey: 'different-server-key',
      recipient: { id: 'user-3', username: 'carol' },
    });

    await expect(startDm('user-3')).resolves.not.toThrow();
    expect(mockPersistGroupKey).toHaveBeenCalledWith('dm-new', 'generated-key-base64');
  });
});

// ---------------------------------------------------------------------------
// joinOrbit
// ---------------------------------------------------------------------------

describe('joinOrbit', () => {
  it('joins with invite code and processes wrapped key', async () => {
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-1',
      encryptedName: 'Encrypted Name',
      memberCount: 3,
      joinedAt: '2026-05-01T00:00:00Z',
      wrappedGroupKey: 'wrapped-key-base64',
    });

    const result = await joinOrbit('ABC12345');

    expect(mockJoinGroup).toHaveBeenCalledWith({ inviteCode: 'ABC12345' });
    expect(mockProcessReceivedGroupKey).toHaveBeenCalledWith('orbit-1', 'wrapped-key-base64', null);
    expect(result.groupId).toBe('orbit-1');
  });

  it('handles null wrappedGroupKey (pending key state)', async () => {
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-2',
      encryptedName: 'Encrypted Name',
      memberCount: 2,
      joinedAt: '2026-05-01T00:00:00Z',
      wrappedGroupKey: null,
    });

    const result = await joinOrbit('XYZ98765');

    expect(mockProcessReceivedGroupKey).not.toHaveBeenCalled();
    expect(result.groupId).toBe('orbit-2');
  });

  it('falls back to (unable to decrypt) on name decryption failure', async () => {
    mockDecryptGroupName.mockImplementationOnce(() => { throw new Error('decrypt error'); });
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-3',
      encryptedName: 'Bad Ciphertext',
      memberCount: 2,
      joinedAt: '2026-05-01T00:00:00Z',
      wrappedGroupKey: 'some-key',
    });

    const result = await joinOrbit('CODE1234');

    expect(result.name).toBe('(unable to decrypt)');
  });
});
