import type { StateCreator } from 'zustand';
import type { AppState, ConnectionSlice } from '../../types/store';

export const createConnectionSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  ConnectionSlice
> = (set, get) => ({
  // Initial state
  connectionStatus: 'disconnected',
  lastConnectedAt: null,
  reconnectAttempt: 0,
  typingUsers: {},

  // Actions
  setConnectionStatus: (status) =>
    set({ connectionStatus: status }, false, 'connection/setConnectionStatus'),

  setLastConnectedAt: (timestamp) =>
    set({ lastConnectedAt: timestamp }, false, 'connection/setLastConnectedAt'),

  setReconnectAttempt: (attempt) =>
    set({ reconnectAttempt: attempt }, false, 'connection/setReconnectAttempt'),

  addTypingUser: (conversationId, entry) => {
    const { typingUsers } = get();
    const current = typingUsers[conversationId] ?? [];
    // Replace if user already in list, otherwise append
    const filtered = current.filter((e) => e.userId !== entry.userId);
    set(
      {
        typingUsers: {
          ...typingUsers,
          [conversationId]: [...filtered, entry],
        },
      },
      false,
      'connection/addTypingUser',
    );
  },

  removeTypingUser: (conversationId, userId) => {
    const { typingUsers } = get();
    const current = typingUsers[conversationId];
    if (!current) return;
    const filtered = current.filter((e) => e.userId !== userId);
    set(
      {
        typingUsers: {
          ...typingUsers,
          [conversationId]: filtered,
        },
      },
      false,
      'connection/removeTypingUser',
    );
  },

  clearTypingUsers: () =>
    set({ typingUsers: {} }, false, 'connection/clearTypingUsers'),
});
