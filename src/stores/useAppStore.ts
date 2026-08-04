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
import { createNotificationSlice } from './slices/notificationSlice';
import { createBlockedUsersSlice } from './slices/blockedUsersSlice';
import { createReportSlice } from './slices/reportSlice';
import type { AppState } from '../types/store';

/**
 * Shape of the persisted (fast-start) subset of app state.
 * Only this data survives app restarts without a server round-trip.
 */
export type PersistedState = Pick<
  AppState,
  'conversations' | 'conversationIds' | 'contacts' | 'colorScheme' | 'activeTab' | 'soundEnabled' | 'blockedUserIds' | 'blockedUserProfiles' | 'threadLastViewedAt' | 'notificationPrefs' | 'mutedTargets' | 'pendingMuteOps'
>;

/**
 * Select the persisted (fast-start) subset of app state.
 *
 * Exported so persistence.test.ts asserts against the REAL selector rather
 * than a copy that can silently drift from this file.
 *
 * Only persist fast-start data — data that should survive app restarts without
 * a round-trip to the server.
 *
 * Explicitly excluded from persistence:
 * - auth state (isAuthenticated, userId, etc.) — JWT tokens live in
 *   Keychain/Keystore; auth state is re-derived on startup
 * - threads, replies, messages — fetched fresh from SQLite/SQLCipher on load
 * - activeConversationId, activeThreadId — transient navigation state
 * - isComposerOpen — transient UI state
 * - syncOverallStatus — re-computed from pending sync queue on startup
 * - pushPermissionGranted, pushToken — device/OS-derived, re-read at launch;
 *   the FCM token must never sit in persisted state
 *
 * notificationPrefs/mutedTargets (#449) ARE persisted so the UI renders correct
 * toggles and mute glyphs before the login-time sync lands. They are
 * server-authoritative — syncNotificationSettings() overwrites them — and
 * cleared on localWipe via resetNotificationSettings().
 *
 * pendingMuteOps (#678) is persisted so a mute toggled with no connectivity
 * survives a restart: syncNotificationSettings() drains the queue before it
 * trusts the server snapshot, and overlays whatever is still queued on top of
 * it. Entries carry ids only (no content) plus the ownerUserId that scopes them
 * to one account; the queue is cleared on localWipe via
 * resetNotificationSettings().
 */
export function partializeAppState(state: AppState): PersistedState {
  return {
    conversations: state.conversations,
    conversationIds: state.conversationIds,
    contacts: state.contacts,
    colorScheme: state.colorScheme,
    activeTab: state.activeTab,
    soundEnabled: state.soundEnabled,
    blockedUserIds: state.blockedUserIds,
    blockedUserProfiles: state.blockedUserProfiles,
    threadLastViewedAt: state.threadLastViewedAt,
    notificationPrefs: state.notificationPrefs,
    mutedTargets: state.mutedTargets,
    pendingMuteOps: state.pendingMuteOps,
  };
}

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
        ...createNotificationSlice(...a),
        ...createBlockedUsersSlice(...a),
        ...createReportSlice(...a),
      }),
      {
        name: 'orbital-app-store',
        storage: createMMKVStorage<PersistedState>(),
        partialize: partializeAppState,
      },
    ),
    { name: 'OrbitalStore', enabled: __DEV__ },
  ),
);
