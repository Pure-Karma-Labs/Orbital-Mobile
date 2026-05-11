jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
  listDms: jest.fn(),
  createDm: jest.fn(),
}));

const mockPersistGroupKey = jest.fn();
const mockGetOrFetchGroupKey = jest.fn().mockResolvedValue(new Uint8Array(32));
const mockDecryptGroupName = jest.fn((name: string, _key: Uint8Array) => name);
const mockGenerateGroupKey = jest.fn(() => ({
  key: new Uint8Array(32),
  keyBase64: 'generated-key-base64',
}));
jest.mock('../crypto/contentCrypto', () => ({
  persistGroupKey: (...args: unknown[]) => mockPersistGroupKey(...args),
  getOrFetchGroupKey: (groupId: string) => mockGetOrFetchGroupKey(groupId),
  decryptGroupName: (name: string, key: Uint8Array) => mockDecryptGroupName(name, key),
  generateGroupKey: () => mockGenerateGroupKey(),
}));

const mockSetConversations = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockUpsertConversation = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      activeConversationId: null,
      setConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
    })),
  },
}));

import { loadConversations, loadDmConversations, startDm } from '../conversationService';
import { listGroups, listDms, createDm } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';

const mockListGroups = listGroups as jest.Mock;
const mockListDms = listDms as jest.Mock;
const mockCreateDm = createDm as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const GROUP_RESPONSE = {
  groupId: 'g1',
  encryptedName: 'Family Orbit',
  encryptedGroupKey: 'placeholder-key',
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

  it('persists group keys from response', async () => {
    mockListGroups.mockResolvedValue([GROUP_RESPONSE]);

    await loadConversations();

    expect(mockPersistGroupKey).toHaveBeenCalledWith('g1', 'placeholder-key');
  });

  it('skips groups with null encryptedGroupKey', async () => {
    mockListGroups.mockResolvedValue([{ ...GROUP_RESPONSE, encryptedGroupKey: null }]);

    await loadConversations();

    expect(mockPersistGroupKey).not.toHaveBeenCalled();
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
  encryptedGroupKey: 'dm-key-base64',
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

  it('persists DM group keys', async () => {
    mockListDms.mockResolvedValue([DM_RESPONSE]);

    await loadDmConversations();

    expect(mockPersistGroupKey).toHaveBeenCalledWith('dm-1', 'dm-key-base64');
  });

  it('skips DMs with null encryptedGroupKey', async () => {
    mockListDms.mockResolvedValue([{ ...DM_RESPONSE, encryptedGroupKey: null }]);

    await loadDmConversations();

    expect(mockPersistGroupKey).not.toHaveBeenCalled();
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
      groupKey: 'generated-key-base64',
      recipient: { id: 'user-3', username: 'carol' },
    });

    const result = await startDm('user-3');

    expect(mockCreateDm).toHaveBeenCalledWith({
      recipientId: 'user-3',
      encryptedGroupKey: 'generated-key-base64',
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
      groupKey: 'generated-key-base64',
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
      groupKey: 'server-existing-key',
      recipient: { id: 'user-3', username: 'carol' },
    });

    await expect(startDm('user-3')).resolves.not.toThrow();
    expect(mockPersistGroupKey).toHaveBeenCalledWith('dm-existing', 'server-existing-key');
  });

  it('throws when server returns mismatched key for new DM', async () => {
    mockCreateDm.mockResolvedValue({
      groupId: 'dm-new',
      isNew: true,
      groupKey: 'different-server-key',
      recipient: { id: 'user-3', username: 'carol' },
    });

    await expect(startDm('user-3')).rejects.toThrow(
      'Server returned a different key for a newly created DM',
    );
    expect(mockPersistGroupKey).not.toHaveBeenCalled();
  });
});
