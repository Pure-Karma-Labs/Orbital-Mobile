jest.mock('../../database/repositories/replyRepository', () => ({
  deleteRepliesForConversation: jest.fn(),
}));

jest.mock('../../database/repositories/threadRepository', () => ({
  getConversationIdsWithThreads: jest.fn(() => []),
  deleteThreadsForConversation: jest.fn(),
}));

const mockGetDatabase = jest.fn();
jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => false),
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}));

jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
  listDms: jest.fn(),
  createDm: jest.fn(),
  joinGroup: jest.fn(),
  getGroupMembers: jest.fn(),
  getPendingWraps: jest.fn(),
  submitWrappedKey: jest.fn(),
  selfWrapGroupKey: jest.fn(),
  markGroupRead: jest.fn(),
  generateInviteCode: jest.fn().mockResolvedValue(undefined),
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
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
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

jest.mock('../crypto/inviteCrypto', () => ({
  generateInviteCode: jest.fn(() => 'TESTCODE1234567890AB'),
  encryptGroupKeyForInvite: jest.fn(() => 'encrypted-key-base64'),
  stripInviteCode: jest.fn((s: string) => s.replace(/-/g, '').toUpperCase()),
  decryptGroupKeyFromInvite: jest.fn(),
}));

jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(32)),
}));

const mockSetConversations = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockUpsertConversation = jest.fn();
const mockMergeContacts = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-self-user',
      activeConversationId: null,
      conversations: {},
      contacts: {},
      setConversations: mockSetConversations,
      setGroupConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    })),
  },
}));

import { loadConversations, loadDmConversations, startDm, joinOrbit, fetchCreatorOrbitsDecrypted, hydrateContactsFromOrbits, ensureDmConversation, fulfillPendingWraps, clearConversationServiceState, refreshContactAvatar, markConversationReadEverywhere, createInviteCode } from '../conversationService';
import { listGroups, listDms, createDm, joinGroup, getGroupMembers, getPendingWraps, submitWrappedKey, markGroupRead, generateInviteCode as generateInviteCodeApi } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';
import { deleteRepliesForConversation } from '../../database/repositories/replyRepository';
import { getConversationIdsWithThreads, deleteThreadsForConversation } from '../../database/repositories/threadRepository';
import { isDatabaseInitialized } from '../../database/connection';

const mockDeleteReplies = deleteRepliesForConversation as jest.Mock;
const mockDeleteThreads = deleteThreadsForConversation as jest.Mock;
const mockGetLocalConvIds = getConversationIdsWithThreads as jest.Mock;
const mockIsDatabaseInitialized = isDatabaseInitialized as jest.Mock;

const mockListGroups = listGroups as jest.Mock;
const mockListDms = listDms as jest.Mock;
const mockCreateDm = createDm as jest.Mock;
const mockJoinGroup = joinGroup as jest.Mock;
const mockGetGroupMembers = getGroupMembers as jest.Mock;
const mockGetPendingWraps = getPendingWraps as jest.Mock;
const mockSubmitWrappedKey = submitWrappedKey as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (useAppStore.getState as jest.Mock).mockReturnValue({
    userId: 'test-self-user',
    activeConversationId: null,
    conversations: {},
    contacts: {},
    setConversations: mockSetConversations,
    setGroupConversations: mockSetConversations,
    setActiveConversation: mockSetActiveConversation,
    upsertConversation: mockUpsertConversation,
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });
});

const GROUP_RESPONSE = {
  groupId: 'g1',
  encryptedName: 'Family Orbit',
  wrappedGroupKey: 'placeholder-key',
  wrappedBy: 'sender-user-1',
  memberCount: 3,
  maxMembers: 10,
  isCreator: false,
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
      conversations: {},
      contacts: {},
      setConversations: mockSetConversations,
      setGroupConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
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
// loadConversations — dissolution cleanup
// ---------------------------------------------------------------------------

describe('loadConversations — dissolution cleanup', () => {
  it('dissolved group triggers transactional delete of replies and threads', async () => {
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockGetLocalConvIds.mockReturnValue(['g1', 'dissolved-group']);
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]); // server only returns g1

    const mockExecuteSync = jest.fn();
    mockGetDatabase.mockReturnValue({ executeSync: mockExecuteSync });

    await loadConversations();

    expect(mockDeleteReplies).toHaveBeenCalledWith('dissolved-group');
    expect(mockDeleteThreads).toHaveBeenCalledWith('dissolved-group');
    expect(mockExecuteSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockExecuteSync).toHaveBeenCalledWith('COMMIT');
  });

  it('no dissolved groups — delete functions not called', async () => {
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockGetLocalConvIds.mockReturnValue(['g1']); // matches the single server group
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    const mockExecuteSync = jest.fn();
    mockGetDatabase.mockReturnValue({ executeSync: mockExecuteSync });

    await loadConversations();

    expect(mockDeleteReplies).not.toHaveBeenCalled();
    expect(mockDeleteThreads).not.toHaveBeenCalled();
  });

  it('isDatabaseInitialized false — cleanup skipped entirely', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockGetLocalConvIds).not.toHaveBeenCalled();
    expect(mockDeleteReplies).not.toHaveBeenCalled();
    expect(mockDeleteThreads).not.toHaveBeenCalled();
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
  it('joins with invite code and decrypts v2 invite key', async () => {
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-1',
      encryptedName: 'Encrypted Name',
      memberCount: 3,
      joinedAt: '2026-05-01T00:00:00Z',
      inviteEncryptedGroupKey: 'encrypted-blob-base64',
    });

    const result = await joinOrbit('ABCD-1234-EFGH-5678-JKMN');

    expect(mockJoinGroup).toHaveBeenCalledWith({ inviteCode: 'ABCD1234EFGH5678JKMN' });
    expect(result.groupId).toBe('orbit-1');
  });

  it('handles null inviteEncryptedGroupKey (pending key state)', async () => {
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-2',
      encryptedName: 'Encrypted Name',
      memberCount: 2,
      joinedAt: '2026-05-01T00:00:00Z',
      inviteEncryptedGroupKey: null,
    });

    const result = await joinOrbit('ABCD-1234-EFGH-5678-JKMN');

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

// ---------------------------------------------------------------------------
// fetchCreatorOrbitsDecrypted
// ---------------------------------------------------------------------------

const CREATOR_GROUP = {
  groupId: 'creator-1',
  encryptedName: 'Family Orbit',
  wrappedGroupKey: 'wrapped-key',
  wrappedBy: 'sender-1',
  memberCount: 4,
  maxMembers: 10,
  isCreator: true,
  joinedAt: '2026-01-01T00:00:00.000Z',
};

const NON_CREATOR_GROUP = {
  groupId: 'member-1',
  encryptedName: 'Other Orbit',
  wrappedGroupKey: 'wrapped-key-2',
  wrappedBy: 'sender-2',
  memberCount: 6,
  maxMembers: 10,
  isCreator: false,
  joinedAt: '2026-02-01T00:00:00.000Z',
};

const CREATOR_DM = {
  ...CREATOR_GROUP,
  groupId: 'dm-created-by-me',
  encryptedName: 'DM',
  memberCount: 2,
  groupType: 'dm' as const,
};

describe('fetchCreatorOrbitsDecrypted', () => {
  it('filters out non-creator groups', async () => {
    mockListGroups.mockResolvedValue([CREATOR_GROUP, NON_CREATOR_GROUP]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('creator-1');
  });

  it('decrypts group names via getOrFetchGroupKey + decryptGroupName', async () => {
    mockListGroups.mockResolvedValue([CREATOR_GROUP]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('creator-1');
    expect(mockDecryptGroupName).toHaveBeenCalledWith('Family Orbit', new Uint8Array(32));
    expect(result[0].name).toBe('Family Orbit');
  });

  it('falls back to (unable to decrypt) when key fetch fails', async () => {
    mockGetOrFetchGroupKey.mockRejectedValueOnce(new Error('no key'));
    mockListGroups.mockResolvedValue([CREATOR_GROUP]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result[0].name).toBe('(unable to decrypt)');
  });

  it('uses groupId as name when encryptedName is null', async () => {
    mockListGroups.mockResolvedValue([
      { ...CREATOR_GROUP, encryptedName: null },
    ]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result[0].name).toBe('creator-1');
  });

  it('passes through memberCount and isCreator', async () => {
    mockListGroups.mockResolvedValue([CREATOR_GROUP]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result[0]).toEqual(expect.objectContaining({
      memberCount: 4,
      isCreator: true,
    }));
  });

  it('returns empty array when listGroups returns empty', async () => {
    mockListGroups.mockResolvedValue([]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result).toEqual([]);
  });

  it('propagates API errors from listGroups', async () => {
    mockListGroups.mockRejectedValue(new Error('network failure'));

    await expect(fetchCreatorOrbitsDecrypted()).rejects.toThrow('network failure');
  });

  it('filters out creator DMs (groupType === dm)', async () => {
    mockListGroups.mockResolvedValue([CREATOR_GROUP, CREATOR_DM]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('creator-1');
  });

  it('includes groups without groupType (backwards compat)', async () => {
    mockListGroups.mockResolvedValue([CREATOR_GROUP]);

    const result = await fetchCreatorOrbitsDecrypted();

    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('creator-1');
  });
});

// ---------------------------------------------------------------------------
// loadDmConversations — contact merge
// ---------------------------------------------------------------------------

describe('loadDmConversations — contact merge', () => {
  it('merges DM recipients as contacts after loading DMs', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await loadDmConversations();

    expect(mockMergeContacts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'user-2',
        username: 'bob',
        displayName: null,
        conversationIds: ['dm-1'],
      }),
    ]);
  });

  it('does not call mergeContacts when DM list is empty', async () => {
    mockListDms.mockResolvedValue([]);

    await loadDmConversations();

    expect(mockMergeContacts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hydrateContactsFromOrbits
// ---------------------------------------------------------------------------

let hydrateTestClock = Date.now();
describe('hydrateContactsFromOrbits', () => {
  beforeEach(() => {
    hydrateTestClock += 120_000;
    jest.useFakeTimers();
    jest.setSystemTime(hydrateTestClock);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches members from group conversations and merges as contacts', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {},
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });
    mockGetGroupMembers.mockResolvedValue([
      { userId: 'member-1', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
      { userId: 'test-self-user', username: 'self', displayName: 'Self', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
    ]);

    await hydrateContactsFromOrbits();

    expect(mockGetGroupMembers).toHaveBeenCalledWith('g1');
    expect(mockMergeContacts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'member-1',
        username: 'alice',
        displayName: 'Alice',
        conversationIds: ['g1'],
      }),
    ]);
  });

  it('excludes the current user from merged contacts', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {},
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });
    mockGetGroupMembers.mockResolvedValue([
      { userId: 'test-self-user', username: 'self', displayName: 'Self', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
    ]);

    await hydrateContactsFromOrbits();

    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('skips direct conversations (only processes groups)', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'dm-1': { id: 'dm-1', type: 'direct', name: 'Bob' },
      },
      contacts: {},
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });

    await hydrateContactsFromOrbits();

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('does nothing when userId is null', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: null,
      conversations: {},
      contacts: {},
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });

    await hydrateContactsFromOrbits();

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
  });

  it('continues when one group member fetch fails', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
        'g2': { id: 'g2', type: 'group', name: 'Orbit 2' },
      },
      contacts: {},
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });
    mockGetGroupMembers
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([
        { userId: 'member-1', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
      ]);

    await hydrateContactsFromOrbits();

    expect(mockMergeContacts).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'member-1', username: 'alice' }),
    ]);
  });

  it('removes orphaned contacts no longer in any orbit', async () => {
    const mockRemoveContact = jest.fn();
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'stale-user': {
          id: 'stale-user',
          username: 'stale',
          displayName: 'Stale',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
      removeContact: mockRemoveContact,
    });
    mockGetGroupMembers.mockResolvedValue([
      { userId: 'member-1', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
    ]);

    await hydrateContactsFromOrbits();

    expect(mockRemoveContact).toHaveBeenCalledWith('stale-user');
  });

  it('does not remove contacts when their orbit fetch failed', async () => {
    const mockRemoveContact = jest.fn();
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'bob': {
          id: 'bob',
          username: 'bob',
          displayName: 'Bob',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
      removeContact: mockRemoveContact,
    });
    mockGetGroupMembers.mockRejectedValue(new Error('network'));

    await hydrateContactsFromOrbits();

    expect(mockRemoveContact).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hydrateContactsFromOrbits — debounce and concurrency
// ---------------------------------------------------------------------------

let debounceTestClock = Date.now() + 500_000;
describe('hydrateContactsFromOrbits — debounce and concurrency', () => {
  const storeState = () => ({
    userId: 'self',
    conversations: { g1: { id: 'g1', type: 'group', name: 'Orbit' } },
    contacts: {},
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });

  beforeEach(() => {
    debounceTestClock += 120_000;
    jest.useFakeTimers();
    jest.setSystemTime(debounceTestClock);
    clearConversationServiceState();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows immediate retry when all fetches fail', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());
    mockGetGroupMembers.mockRejectedValue(new Error('network'));

    await hydrateContactsFromOrbits();
    expect(mockGetGroupMembers).toHaveBeenCalledTimes(1);

    mockGetGroupMembers.mockClear();
    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());

    await hydrateContactsFromOrbits();
    expect(mockGetGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('debounces after successful hydration', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());
    mockGetGroupMembers.mockResolvedValue([
      { userId: 'a', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
    ]);

    await hydrateContactsFromOrbits();
    expect(mockGetGroupMembers).toHaveBeenCalledTimes(1);

    mockGetGroupMembers.mockClear();
    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());

    await hydrateContactsFromOrbits();
    expect(mockGetGroupMembers).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls via in-flight guard', async () => {
    let resolveMembers!: (v: unknown[]) => void;
    const deferredMembers = new Promise<unknown[]>((r) => { resolveMembers = r; });

    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());
    mockGetGroupMembers.mockReturnValue(deferredMembers);

    const call1 = hydrateContactsFromOrbits();
    const call2 = hydrateContactsFromOrbits();

    resolveMembers([
      { userId: 'a', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
    ]);

    await call1;
    await call2;

    expect(mockGetGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('advances timestamp on partial failure', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      ...storeState(),
      conversations: {
        g1: { id: 'g1', type: 'group', name: 'Orbit 1' },
        g2: { id: 'g2', type: 'group', name: 'Orbit 2' },
      },
    });
    mockGetGroupMembers
      .mockResolvedValueOnce([
        { userId: 'a', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
      ])
      .mockRejectedValueOnce(new Error('network'));

    await hydrateContactsFromOrbits();

    mockGetGroupMembers.mockClear();
    (useAppStore.getState as jest.Mock).mockReturnValue(storeState());

    await hydrateContactsFromOrbits();
    expect(mockGetGroupMembers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session-stale guards (#241) — cross-session data contamination prevention
// ---------------------------------------------------------------------------

describe('session-stale guards', () => {
  /** Store state with all required methods but a null userId */
  const nullUserState = () => ({
    userId: null,
    activeConversationId: null,
    conversations: {},
    contacts: {},
    setConversations: mockSetConversations,
    setGroupConversations: mockSetConversations,
    setActiveConversation: mockSetActiveConversation,
    upsertConversation: mockUpsertConversation,
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });

  /** Store state with a valid userId and all required methods */
  const validUserState = () => ({
    userId: 'test-self-user',
    activeConversationId: null,
    conversations: {},
    contacts: {},
    setConversations: mockSetConversations,
    setGroupConversations: mockSetConversations,
    setActiveConversation: mockSetActiveConversation,
    upsertConversation: mockUpsertConversation,
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });

  describe('loadConversations bails on mid-flight logout', () => {
    it('does not call setConversations when userId becomes null mid-flight', async () => {
      // First getState() call (captureSession) returns valid user
      // Subsequent calls (after await) return null userId
      (useAppStore.getState as jest.Mock)
        .mockReturnValueOnce(validUserState())
        .mockReturnValue(nullUserState());

      mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

      await loadConversations();

      expect(mockListGroups).toHaveBeenCalled();
      expect(mockSetConversations).not.toHaveBeenCalled();
    });
  });

  describe('loadDmConversations bails on mid-flight logout', () => {
    it('does not call upsertConversation when userId becomes null mid-flight', async () => {
      (useAppStore.getState as jest.Mock)
        .mockReturnValueOnce(validUserState())
        .mockReturnValue(nullUserState());

      mockListDms.mockResolvedValue([DM_RESPONSE]);

      await loadDmConversations();

      expect(mockListDms).toHaveBeenCalled();
      expect(mockUpsertConversation).not.toHaveBeenCalled();
    });
  });

  describe('hydrateContactsFromOrbits bails on mid-flight logout', () => {
    let hydrateStaleTestClock = Date.now() + 1_000_000;

    beforeEach(() => {
      hydrateStaleTestClock += 120_000;
      jest.useFakeTimers();
      jest.setSystemTime(hydrateStaleTestClock);
      clearConversationServiceState();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not call mergeContacts when userId becomes null after API call', async () => {
      // First getState (captureSession) returns valid user with a group conversation
      // Second getState (for conversations) also returns valid state with the group
      // After the await Promise.all, getState returns null userId
      const stateWithGroup = {
        ...validUserState(),
        conversations: { g1: { id: 'g1', type: 'group', name: 'Orbit' } },
      };
      (useAppStore.getState as jest.Mock)
        .mockReturnValueOnce(stateWithGroup) // captureSession
        .mockReturnValueOnce(stateWithGroup) // read conversations
        .mockReturnValue(nullUserState()); // after await — session stale

      mockGetGroupMembers.mockResolvedValue([
        { userId: 'member-1', username: 'alice', displayName: 'Alice', publicKey: 'pk', avatarUrl: null, joinedAt: '2026-01-01' },
      ]);

      await hydrateContactsFromOrbits();

      // Verify we actually called the API (got past early returns)
      expect(mockGetGroupMembers).toHaveBeenCalled();
      // But the guard prevented the store write
      expect(mockMergeContacts).not.toHaveBeenCalled();
    });
  });

  describe('session generation change (same userId, different session)', () => {
    it('bails when clearConversationServiceState is called mid-flight', async () => {
      // Use mockImplementation to bump generation during the async gap
      mockListGroups.mockImplementation(async () => {
        clearConversationServiceState(); // bumps generation after captureSession ran
        return [GROUP_RESPONSE];
      });

      (useAppStore.getState as jest.Mock).mockReturnValue(validUserState());

      await loadConversations();

      // listGroups was called (we got past the early return)
      expect(mockListGroups).toHaveBeenCalled();
      // But setConversations was NOT called because generation changed
      expect(mockSetConversations).not.toHaveBeenCalled();
    });
  });

  describe('ensureDmConversation bails on mid-flight logout', () => {
    it('does not call upsertConversation when userId becomes null mid-flight', async () => {
      // First getState (store.conversations lookup) returns no existing conv
      // Second getState (captureSession inside IIFE) returns valid user
      // After awaits, getState returns null userId
      (useAppStore.getState as jest.Mock)
        .mockReturnValueOnce({ ...validUserState(), conversations: {} }) // existing conv lookup
        .mockReturnValueOnce(validUserState()) // captureSession
        .mockReturnValue(nullUserState()); // after await — session stale

      mockListDms.mockResolvedValue([DM_RESPONSE]);

      const result = await ensureDmConversation('dm-1');

      expect(mockListDms).toHaveBeenCalled();
      expect(mockUpsertConversation).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('fulfillPendingWraps bails on mid-flight session change', () => {
    it('skips second group when session becomes stale during first', async () => {
      // Guard is at the top of the outer loop, so it catches staleness
      // between group iterations, not within a single group.
      const stateWithGroups = {
        ...validUserState(),
        conversations: {
          g1: { id: 'g1', type: 'group', name: 'Orbit 1' },
          g2: { id: 'g2', type: 'group', name: 'Orbit 2' },
        },
      };
      (useAppStore.getState as jest.Mock).mockReturnValue(stateWithGroups);

      mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
      // First group: bump generation during processing
      mockGetPendingWraps.mockImplementationOnce(async () => {
        clearConversationServiceState(); // bump generation after first iteration started
        return [{ userId: 'member-1' }];
      });
      // Second group: should never be reached
      mockGetPendingWraps.mockResolvedValue([{ userId: 'member-2' }]);

      await fulfillPendingWraps();

      // First group was processed (guard passed at top of first iteration)
      expect(mockGetPendingWraps).toHaveBeenCalledTimes(1);
      // Second group was skipped because isSessionStale returned true
      expect(mockSubmitWrappedKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('cross-user session change (user A to user B)', () => {
    it('bails when a different user logs in mid-flight', async () => {
      const userBState = () => ({
        ...validUserState(),
        userId: 'different-user-B',
      });

      (useAppStore.getState as jest.Mock)
        .mockReturnValueOnce(validUserState()) // captureSession as user A
        .mockReturnValue(userBState()); // after await — different user

      mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

      await loadConversations();

      expect(mockListGroups).toHaveBeenCalled();
      expect(mockSetConversations).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// refreshContactAvatar
// ---------------------------------------------------------------------------

describe('refreshContactAvatar', () => {
  beforeEach(() => {
    clearConversationServiceState();
  });

  it('fetches group members and merges contact with avatar metadata', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    mockGetGroupMembers.mockResolvedValue([
      {
        userId: 'member-1',
        username: 'alice',
        displayName: 'Alice',
        publicKey: 'pk',
        avatarUrl: '/avatars/alice.enc',
        joinedAt: '2026-01-01',
        avatarEncryptedKey: 'enc-key-base64',
        avatarKeyIv: 'iv-base64',
        avatarDigest: 'digest-base64',
      },
    ]);

    await refreshContactAvatar('member-1');

    expect(mockGetGroupMembers).toHaveBeenCalledWith('g1');
    expect(mockMergeContacts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'member-1',
        username: 'alice',
        avatarPath: '/avatars/alice.enc',
        avatarEncryptedKey: 'enc-key-base64',
        avatarKeyIv: 'iv-base64',
        avatarDigest: 'digest-base64',
        conversationIds: ['g1'],
      }),
    ]);
  });

  it('returns early for own userId', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {},
      contacts: {},
      mergeContacts: mockMergeContacts,
    });

    await refreshContactAvatar('test-self-user');

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('returns early when contact is not found', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {},
      contacts: {},
      mergeContacts: mockMergeContacts,
    });

    await refreshContactAvatar('unknown-user');

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('returns early when contact has empty conversationIds', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {},
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: [],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    await refreshContactAvatar('member-1');

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
  });

  it('returns early when contact only has DM-type conversationIds', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'dm-1': { id: 'dm-1', type: 'direct', name: 'Alice DM' },
      },
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: ['dm-1'],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    await refreshContactAvatar('member-1');

    expect(mockGetGroupMembers).not.toHaveBeenCalled();
  });

  it('does not call mergeContacts when session becomes stale', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    mockGetGroupMembers.mockImplementation(async () => {
      // Bump session generation during the async gap
      clearConversationServiceState();
      return [
        {
          userId: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          publicKey: 'pk',
          avatarUrl: null,
          joinedAt: '2026-01-01',
          avatarEncryptedKey: 'enc-key',
          avatarKeyIv: 'iv',
          avatarDigest: 'digest',
        },
      ];
    });

    await refreshContactAvatar('member-1');

    expect(mockGetGroupMembers).toHaveBeenCalled();
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('propagates getGroupMembers errors to the caller', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    mockGetGroupMembers.mockRejectedValue(new Error('network'));

    await expect(refreshContactAvatar('member-1')).rejects.toThrow('network');
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent calls — getGroupMembers called once', async () => {
    let resolveMembers!: (v: unknown[]) => void;
    const deferred = new Promise<unknown[]>((r) => { resolveMembers = r; });

    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {
        'g1': { id: 'g1', type: 'group', name: 'Orbit 1' },
      },
      contacts: {
        'member-1': {
          id: 'member-1',
          username: 'alice',
          displayName: 'Alice',
          avatarPath: null,
          conversationIds: ['g1'],
        },
      },
      mergeContacts: mockMergeContacts,
    });

    mockGetGroupMembers.mockReturnValue(deferred);

    const call1 = refreshContactAvatar('member-1');
    const call2 = refreshContactAvatar('member-1');

    resolveMembers([
      {
        userId: 'member-1',
        username: 'alice',
        displayName: 'Alice',
        publicKey: 'pk',
        avatarUrl: null,
        joinedAt: '2026-01-01',
      },
    ]);

    await call1;
    await call2;

    expect(mockGetGroupMembers).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// markConversationReadEverywhere — local zero + debounced remote (#329)
// ---------------------------------------------------------------------------

describe('markConversationReadEverywhere', () => {
  const mockMarkGroupRead = markGroupRead as jest.Mock;
  const mockMarkConversationRead = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    mockMarkGroupRead.mockResolvedValue({ lastReadAt: '2026-06-12T00:00:00Z' });
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      activeConversationId: null,
      conversations: {},
      contacts: {},
      viewingConversationId: null,
      markConversationRead: mockMarkConversationRead,
      setConversations: mockSetConversations,
      setGroupConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });
  });

  afterEach(() => {
    clearConversationServiceState();
    jest.useRealTimers();
  });

  it('zeroes the local count immediately, defers the server call', () => {
    markConversationReadEverywhere('conv-1');

    expect(mockMarkConversationRead).toHaveBeenCalledWith('conv-1');
    expect(mockMarkGroupRead).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3_000);
    expect(mockMarkGroupRead).toHaveBeenCalledTimes(1);
    expect(mockMarkGroupRead).toHaveBeenCalledWith('conv-1');
  });

  it('debounces rapid calls per conversation into one server call', () => {
    markConversationReadEverywhere('conv-1');
    jest.advanceTimersByTime(1_000);
    markConversationReadEverywhere('conv-1');
    jest.advanceTimersByTime(1_000);
    markConversationReadEverywhere('conv-1');

    jest.advanceTimersByTime(3_000);
    expect(mockMarkGroupRead).toHaveBeenCalledTimes(1);
  });

  it('debounces independently per conversation', () => {
    markConversationReadEverywhere('conv-1');
    markConversationReadEverywhere('conv-2');

    jest.advanceTimersByTime(3_000);
    expect(mockMarkGroupRead).toHaveBeenCalledTimes(2);
    expect(mockMarkGroupRead).toHaveBeenCalledWith('conv-1');
    expect(mockMarkGroupRead).toHaveBeenCalledWith('conv-2');
  });

  it('clearConversationServiceState cancels pending server calls (logout)', () => {
    markConversationReadEverywhere('conv-1');
    clearConversationServiceState();

    jest.advanceTimersByTime(10_000);
    expect(mockMarkGroupRead).not.toHaveBeenCalled();
  });

  it('swallows server errors (fire-and-forget)', async () => {
    mockMarkGroupRead.mockRejectedValue(new Error('network down'));
    markConversationReadEverywhere('conv-1');

    jest.advanceTimersByTime(3_000);
    // Flush the rejected promise — must not throw or produce unhandled rejection
    await Promise.resolve();
    expect(mockMarkGroupRead).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// loadConversations uses the type-partitioned action (#329 load-wipe regression)
// ---------------------------------------------------------------------------

describe('loadConversations — store action choice (load-wipe regression)', () => {
  it('calls setGroupConversations, never the map-replacing setConversations', async () => {
    const distinctSetConversations = jest.fn();
    const distinctSetGroupConversations = jest.fn();
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      activeConversationId: 'existing-id',
      conversations: {},
      contacts: {},
      viewingConversationId: null,
      setConversations: distinctSetConversations,
      setGroupConversations: distinctSetGroupConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    });
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    // The DM-wiping bug was loadConversations calling setConversations(groups),
    // replacing the entire map. It must use the type-partitioned action instead.
    expect(distinctSetGroupConversations).toHaveBeenCalledTimes(1);
    expect(distinctSetConversations).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createInviteCode — input validation (#375)
// ---------------------------------------------------------------------------

describe('createInviteCode', () => {
  it('throws when groupId is empty', async () => {
    await expect(createInviteCode('', 'test@example.com')).rejects.toThrow('groupId is required');
  });

  it('throws when targetEmail is empty', async () => {
    await expect(createInviteCode('group-1', '')).rejects.toThrow('targetEmail is required');
  });

  it('generates invite code and calls API on valid inputs', async () => {
    const code = await createInviteCode('group-1', 'test@example.com');

    expect(code).toBe('TESTCODE1234567890AB');
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(generateInviteCodeApi).toHaveBeenCalledWith('group-1', 'test@example.com', {
      code: 'TESTCODE1234567890AB',
      encryptedGroupKey: 'encrypted-key-base64',
    });
  });
});
