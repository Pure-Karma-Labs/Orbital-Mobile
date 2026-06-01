jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
  listDms: jest.fn(),
  createDm: jest.fn(),
  joinGroup: jest.fn(),
  getGroupMembers: jest.fn(),
}));

const mockProcessReceivedGroupKey = jest.fn().mockResolvedValue(undefined);
jest.mock('../crypto/contentCrypto', () => ({
  persistGroupKey: jest.fn(),
  processReceivedGroupKey: (...args: unknown[]) => mockProcessReceivedGroupKey(...args),
  getOrFetchGroupKey: jest.fn().mockResolvedValue(new Uint8Array(32)),
  decryptGroupName: jest.fn((name: string) => name),
  encryptGroupName: jest.fn(() => 'encrypted-name'),
  generateGroupKey: jest.fn(() => ({
    key: new Uint8Array(32),
    keyBase64: 'generated-key-base64',
  })),
  wrapGroupKey: jest.fn(() => 'ecies-wrapped-base64'),
  loadPersistedGroupKey: jest.fn(),
  setCachedGroupKey: jest.fn(),
  evictPendingCache: jest.fn(),
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

const mockUpsertConversation = jest.fn();
const mockMergeContacts = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-self-user',
      activeConversationId: null,
      conversations: {},
      contacts: {},
      setConversations: jest.fn(),
      setActiveConversation: jest.fn(),
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    })),
  },
}));

import { ensureDmConversation } from '../conversationService';
import { listDms } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';

const mockListDms = listDms as jest.Mock;

const DM_RESPONSE = {
  groupId: 'dm-1',
  recipient: { id: 'user-2', username: 'bob', avatarUrl: null },
  wrappedGroupKey: 'dm-key-base64',
  wrappedBy: 'dm-sender-1',
  lastMessageAt: '2026-03-15T12:00:00.000Z',
  createdAt: '2026-03-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  (useAppStore.getState as jest.Mock).mockReturnValue({
    userId: 'test-self-user',
    activeConversationId: null,
    conversations: {},
    contacts: {},
    setConversations: jest.fn(),
    setActiveConversation: jest.fn(),
    upsertConversation: mockUpsertConversation,
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });
});

describe('ensureDmConversation', () => {
  it('returns existing conversation without API call', async () => {
    const existing = {
      id: 'dm-1',
      type: 'direct' as const,
      name: 'bob',
      memberCount: 2,
      active: true,
      muteUntil: null,
      lastMessageAt: null,
      unreadCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: { 'dm-1': existing },
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
    });

    const result = await ensureDmConversation('dm-1');

    expect(result).toBe(existing);
    expect(mockListDms).not.toHaveBeenCalled();
  });

  it('calls listDms and creates conversation for new DM', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    const result = await ensureDmConversation('dm-1');

    expect(mockListDms).toHaveBeenCalledTimes(1);
    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dm-1',
        type: 'direct',
        name: 'bob',
        memberCount: 2,
      }),
    );
    expect(mockMergeContacts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'user-2',
        username: 'bob',
        conversationIds: ['dm-1'],
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({ id: 'dm-1', type: 'direct' }),
    );
  });

  it('returns null for unknown groupId and does not mutate store', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    const result = await ensureDmConversation('unknown-group');

    expect(result).toBeNull();
    expect(mockUpsertConversation).not.toHaveBeenCalled();
    expect(mockMergeContacts).not.toHaveBeenCalled();
  });

  it('concurrent calls coalesce (only one listDms call)', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    const [r1, r2] = await Promise.all([
      ensureDmConversation('dm-1'),
      ensureDmConversation('dm-1'),
    ]);

    expect(mockListDms).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it('processes wrapped group key when available', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await ensureDmConversation('dm-1');

    expect(mockResolveRemoteIdentityKey).toHaveBeenCalledWith('dm-sender-1', 'test-self-user');
    expect(mockProcessReceivedGroupKey).toHaveBeenCalledWith('dm-1', 'dm-key-base64', 'dm-sender-1');
  });

  it('skips key processing when wrappedGroupKey is null', async () => {
    mockListDms.mockResolvedValue([{ ...DM_RESPONSE, wrappedGroupKey: null }]);

    await ensureDmConversation('dm-1');

    expect(mockProcessReceivedGroupKey).not.toHaveBeenCalled();
  });
});
