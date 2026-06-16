import type { StateCreator } from 'zustand';
import type {
  AppState,
  Conversation,
  ConversationsSlice,
} from '../../types/store';

/** Sort comparator: most recently active conversations first */
function sortByLastMessage(a: Conversation, b: Conversation): number {
  const aTime = a.lastMessageAt ?? 0;
  const bTime = b.lastMessageAt ?? 0;
  return bTime - aTime;
}

export const createConversationsSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  ConversationsSlice
> = (set, get) => ({
  // Initial state
  conversations: {},
  conversationIds: [],
  activeConversationId: null,
  viewingConversationId: null,

  // Actions
  setConversations: (conversations) => {
    const map: Record<string, Conversation> = {};
    for (const c of conversations) {
      map[c.id] = c;
    }
    const ids = [...conversations].sort(sortByLastMessage).map((c) => c.id);
    set(
      { conversations: map, conversationIds: ids },
      false,
      'conversations/setConversations',
    );
  },

  setGroupConversations: (groupConversations) => {
    const { conversations: existing } = get();
    // Preserve all existing DM ('direct') conversations
    const merged: Record<string, Conversation> = {};
    for (const [id, conv] of Object.entries(existing)) {
      if (conv.type === 'direct') {
        merged[id] = conv;
      }
    }
    // Replace the entire group partition with the new server list
    for (const c of groupConversations) {
      merged[c.id] = c;
    }
    const ids = Object.values(merged)
      .sort(sortByLastMessage)
      .map((c) => c.id);
    set(
      { conversations: merged, conversationIds: ids },
      false,
      'conversations/setGroupConversations',
    );
  },

  upsertConversation: (conversation) => {
    const { conversations } = get();
    const updatedMap = { ...conversations, [conversation.id]: conversation };
    // Re-sort IDs after upsert
    const updatedIds = Object.values(updatedMap)
      .sort(sortByLastMessage)
      .map((c) => c.id);
    set(
      { conversations: updatedMap, conversationIds: updatedIds },
      false,
      'conversations/upsertConversation',
    );
  },

  removeConversation: (id) => {
    const { conversations, conversationIds, activeConversationId } = get();
    const updatedMap = { ...conversations };
    delete updatedMap[id];
    const updatedIds = conversationIds.filter((cid) => cid !== id);
    set(
      {
        conversations: updatedMap,
        conversationIds: updatedIds,
        activeConversationId:
          activeConversationId === id ? null : activeConversationId,
      },
      false,
      'conversations/removeConversation',
    );
  },

  setActiveConversation: (id) =>
    set(
      { activeConversationId: id },
      false,
      'conversations/setActiveConversation',
    ),

  updateUnreadCount: (id, count) => {
    const { conversations } = get();
    const existing = conversations[id];
    if (!existing) {
      return;
    }
    set(
      {
        conversations: {
          ...conversations,
          [id]: { ...existing, unreadCount: count },
        },
      },
      false,
      'conversations/updateUnreadCount',
    );
  },

  incrementUnreadCount: (id) => {
    const { conversations } = get();
    const existing = conversations[id];
    if (!existing) {
      return;
    }
    set(
      {
        conversations: {
          ...conversations,
          [id]: { ...existing, unreadCount: existing.unreadCount + 1 },
        },
      },
      false,
      'conversations/incrementUnreadCount',
    );
  },

  markConversationRead: (id) => {
    const { conversations } = get();
    const existing = conversations[id];
    if (!existing) {
      return;
    }
    set(
      {
        conversations: {
          ...conversations,
          [id]: { ...existing, unreadCount: 0, lastReadAt: Date.now() },
        },
      },
      false,
      'conversations/markConversationRead',
    );
  },

  setViewingConversation: (id) =>
    set(
      { viewingConversationId: id },
      false,
      'conversations/setViewingConversation',
    ),

  bumpLastMessageAt: (id, timestamp) => {
    const { conversations } = get();
    const existing = conversations[id];
    if (!existing) {
      return;
    }
    if (timestamp <= (existing.lastMessageAt ?? 0)) {
      return;
    }
    const updated = { ...existing, lastMessageAt: timestamp, updatedAt: timestamp };
    const updatedMap = { ...conversations, [id]: updated };
    const updatedIds = Object.values(updatedMap)
      .sort(sortByLastMessage)
      .map((c) => c.id);
    set(
      { conversations: updatedMap, conversationIds: updatedIds },
      false,
      'conversations/bumpLastMessageAt',
    );
  },
});
