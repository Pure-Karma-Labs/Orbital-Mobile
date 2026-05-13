import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createMMKVStorage } from './middleware/persistence';
import { createAuthSlice } from './slices/authSlice';
import { createConversationsSlice } from './slices/conversationsSlice';
import { createContactsSlice } from './slices/contactsSlice';
import { createThreadsSlice } from './slices/threadsSlice';
import { createUISlice } from './slices/uiSlice';
import { createConnectionSlice } from './slices/connectionSlice';
import { createMediaSlice } from './slices/mediaSlice';
import type { AppState } from '../types/store';

/**
 * Shape of the persisted (fast-start) subset of app state.
 * Only this data survives app restarts without a server round-trip.
 */
type PersistedState = Pick<
  AppState,
  'conversations' | 'conversationIds' | 'contacts' | 'colorScheme' | 'activeTab' | 'soundEnabled'
>;

export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (...a) => ({
        ...createAuthSlice(...a),
        ...createConversationsSlice(...a),
        ...createThreadsSlice(...a),
        ...createContactsSlice(...a),
        ...createUISlice(...a),
        ...createConnectionSlice(...a),
        ...createMediaSlice(...a),
      }),
      {
        name: 'orbital-app-store',
        storage: createMMKVStorage<PersistedState>(),
        /**
         * Only persist fast-start data — data that should survive app restarts
         * without a round-trip to the server.
         *
         * Explicitly excluded from persistence:
         * - auth state (isAuthenticated, userId, etc.) — JWT tokens live in
         *   Keychain/Keystore; auth state is re-derived on startup
         * - threads, replies, messages — fetched fresh from SQLite/SQLCipher on load
         * - activeConversationId, activeThreadId — transient navigation state
         * - isComposerOpen — transient UI state
         * - syncOverallStatus — re-computed from pending sync queue on startup
         */
        partialize: (state): PersistedState => ({
          conversations: state.conversations,
          conversationIds: state.conversationIds,
          contacts: state.contacts,
          colorScheme: state.colorScheme,
          activeTab: state.activeTab,
          soundEnabled: state.soundEnabled,
        }),
      },
    ),
    { name: 'OrbitalStore', enabled: __DEV__ },
  ),
);
