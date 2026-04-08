import type { StateCreator } from 'zustand';
import type {
  AppState,
  Message,
  MessagesSlice,
  SyncStatus,
} from '../../types/store';

export const createMessagesSlice: StateCreator<
  AppState,
  [],
  [],
  MessagesSlice
> = (set, get) => ({
  // Initial state
  messages: {},
  messageIdsByConversation: {},
  hasMoreMessages: {},

  // Actions
  setMessages: (conversationId, messages) => {
    const { messages: existingMessages, messageIdsByConversation } = get();
    const updatedMessages = { ...existingMessages };
    for (const m of messages) {
      updatedMessages[m.id] = m;
    }
    // Order by serverTimestamp ascending (chronological)
    const ids = [...messages]
      .sort((a, b) => a.serverTimestamp - b.serverTimestamp)
      .map((m) => m.id);
    set(
      {
        messages: updatedMessages,
        messageIdsByConversation: {
          ...messageIdsByConversation,
          [conversationId]: ids,
        },
      },
      false,
      'messages/setMessages',
    );
  },

  addMessage: (message) => {
    const { messages, messageIdsByConversation } = get();
    const existingIds =
      messageIdsByConversation[message.conversationId] ?? [];
    const updatedIds = existingIds.includes(message.id)
      ? existingIds
      : [...existingIds, message.id];
    set(
      {
        messages: { ...messages, [message.id]: message },
        messageIdsByConversation: {
          ...messageIdsByConversation,
          [message.conversationId]: updatedIds,
        },
      },
      false,
      'messages/addMessage',
    );
  },

  addOptimisticMessage: (message: Message) => {
    const { messages, messageIdsByConversation } = get();
    const optimistic: Message = { ...message, syncStatus: 'pending' };
    const existingIds =
      messageIdsByConversation[message.conversationId] ?? [];
    set(
      {
        messages: { ...messages, [message.id]: optimistic },
        messageIdsByConversation: {
          ...messageIdsByConversation,
          [message.conversationId]: [...existingIds, message.id],
        },
      },
      false,
      'messages/addOptimisticMessage',
    );
  },

  updateMessageSyncStatus: (id: string, status: SyncStatus) => {
    const { messages } = get();
    const existing = messages[id];
    if (!existing) {
      return;
    }
    set(
      { messages: { ...messages, [id]: { ...existing, syncStatus: status } } },
      false,
      'messages/updateMessageSyncStatus',
    );
  },

  markMessageRead: (id) => {
    const { messages } = get();
    const existing = messages[id];
    if (!existing) {
      return;
    }
    set(
      { messages: { ...messages, [id]: { ...existing, read: true } } },
      false,
      'messages/markMessageRead',
    );
  },

  setHasMore: (conversationId, hasMore) => {
    const { hasMoreMessages } = get();
    set(
      { hasMoreMessages: { ...hasMoreMessages, [conversationId]: hasMore } },
      false,
      'messages/setHasMore',
    );
  },
});
