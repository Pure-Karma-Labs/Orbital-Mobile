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
import type { NotificationPrefs } from '../types/api';

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

/**
 * Hydration merge: zustand's default top-level spread, plus a per-key floor on
 * notificationPrefs.
 *
 * The default merge REPLACES notificationPrefs wholesale with the persisted
 * object, so a blob written by a build that predates a pref key hydrates that
 * key as `undefined` for the whole session (until a sync GET lands). Suppression
 * reads fail open, so nothing is silently muted — but the settings screen would
 * render a toggle with no value while pushes fire.
 *
 * Only notificationPrefs is floored: it is the one persisted value with a fixed
 * key shape where per-key absence is representable. mutedTargets, pendingMuteOps,
 * threadLastViewedAt and the collections are open maps whose empty default is
 * already the correct base, and the scalars fall back to current state via the
 * top-level spread.
 *
 * Exported for the same reason as partializeAppState: persistence.test.ts must
 * assert the shipped function, never a copy that can drift.
 *
 * The guards exist because zustand calls merge(undefined, current) when storage
 * is empty and passes whatever JSON deserialized to when the blob is corrupt
 * (spreading a string or an array would splatter index keys into state). The
 * floor source is CURRENT prefs, not DEFAULT_NOTIFICATION_PREFS: an empty or
 * unreadable read must be non-destructive, and flooring from the constant would
 * reset every pref to all-on whenever getItem returns null after server truth
 * had already landed.
 *
 * NOT version/migrate: there is no schema change to migrate. migrate only runs
 * on a version mismatch, which means it depends on someone remembering to bump
 * the version — the exact discipline this issue exists to remove. merge runs
 * unconditionally and is additive-key tolerant with no bookkeeping.
 *
 * Must return a COMPLETE AppState: zustand applies the merge result with
 * set(state, true) (replace mode), so failing to spread `current` wipes every
 * action.
 */
export function mergePersistedAppState(persisted: unknown, current: AppState): AppState {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const rawSaved = isPlainObject(persisted) ? persisted : {};
  // The persist allowlist governs read as well as write — a stale or tampered
  // blob cannot resurrect keys partialize excludes (pushToken, auth).
  const allowed = new Set(Object.keys(partializeAppState(current)));
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawSaved)) {
    if (allowed.has(k)) saved[k] = v;
  }
  const savedPrefs = isPlainObject(saved.notificationPrefs) ? saved.notificationPrefs : {};
  // Per-key boolean floor, mirroring sanitizePrefs' discipline on network input
  // — presence AND type validated, unknown keys clamped out.
  // current.notificationPrefs is provably complete at every rehydrate (initial
  // state is {...DEFAULT}, setNotificationPrefs merges, reset writes the full
  // default).
  const flooredPrefs: Partial<NotificationPrefs> = {};
  for (const k of Object.keys(current.notificationPrefs) as (keyof NotificationPrefs)[]) {
    const savedValue = savedPrefs[k];
    flooredPrefs[k] = typeof savedValue === 'boolean' ? savedValue : current.notificationPrefs[k];
  }
  // The cast only re-narrows Partial — every key of the complete current set
  // was just assigned above; it asserts nothing the loop did not establish.
  return { ...current, ...saved, notificationPrefs: flooredPrefs as NotificationPrefs };
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
        merge: mergePersistedAppState,
      },
    ),
    { name: 'OrbitalStore', enabled: __DEV__ },
  ),
);
