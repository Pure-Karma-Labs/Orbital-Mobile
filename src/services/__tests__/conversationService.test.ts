jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
}));

const mockSetConversations = jest.fn();
const mockSetActiveConversation = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      activeConversationId: null,
      setConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
    })),
  },
}));

import { loadConversations } from '../conversationService';
import { listGroups } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';

const mockListGroups = listGroups as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const GROUP_RESPONSE = {
  id: 'g1',
  type: 'group',
  encryptedName: 'Family Orbit',
  encryptedNameIv: null,
  memberCount: 3,
  creatorId: 'u1',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('loadConversations', () => {
  it('fetches groups and populates store', async () => {
    mockListGroups.mockResolvedValue({ groups: [GROUP_RESPONSE] });

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
    mockListGroups.mockResolvedValue({ groups: [GROUP_RESPONSE] });

    await loadConversations();

    expect(mockSetActiveConversation).toHaveBeenCalledWith('g1');
  });

  it('does not clobber existing activeConversationId', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      activeConversationId: 'existing-id',
      setConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
    });
    mockListGroups.mockResolvedValue({ groups: [GROUP_RESPONSE] });

    await loadConversations();

    expect(mockSetActiveConversation).not.toHaveBeenCalled();
  });

  it('handles empty group list', async () => {
    mockListGroups.mockResolvedValue({ groups: [] });

    await loadConversations();

    expect(mockSetConversations).toHaveBeenCalledWith([]);
    expect(mockSetActiveConversation).not.toHaveBeenCalled();
  });

  it('maps createdAt from ISO string to epoch ms', async () => {
    mockListGroups.mockResolvedValue({ groups: [GROUP_RESPONSE] });

    await loadConversations();

    const conversation = mockSetConversations.mock.calls[0][0][0];
    expect(conversation.createdAt).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('defaults muteUntil, lastMessageAt, unreadCount', async () => {
    mockListGroups.mockResolvedValue({ groups: [GROUP_RESPONSE] });

    await loadConversations();

    const conversation = mockSetConversations.mock.calls[0][0][0];
    expect(conversation.muteUntil).toBeNull();
    expect(conversation.lastMessageAt).toBeNull();
    expect(conversation.unreadCount).toBe(0);
  });

  it('propagates API errors', async () => {
    mockListGroups.mockRejectedValue(new Error('network'));

    await expect(loadConversations()).rejects.toThrow('network');
  });
});
