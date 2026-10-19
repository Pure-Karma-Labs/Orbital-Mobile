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
import { createNotificationSlice, DEFAULT_NOTIFICATION_PREFS } from './slices/notificationSlice';
import { createBlockedUsersSlice } from './slices/blockedUsersSlice';
import { createReportSlice } from './slices/reportSlice';
import { maxTimestamp } from '../utils/threadActivity';
import type { AppState, Conversation } from '../types/store';
import type { NotificationPrefs } from '../types/api';

/**
 * Shape of the persisted (fast-start) subset of app state.
 * Only this data survives app restarts without a server round-trip.
 */
export type PersistedState = Pick<
  AppState,
  'conversations' | 'conversationIds' | 'contacts' | 'colorScheme' | 'activeTab' | 'soundEnabled' | 'blockedUserIds' | 'blockedUserProfiles' | 'threadLastViewedAt' | 'notificationPrefs' | 'mutedTargets' | 'pendingMuteOps' | 'pushOptOut'
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
 * - groupKeyGeneration (#912) — a per-session reload trigger. A restored
 *   counter would read as "a key was just delivered" on the first render after
 *   every launch, and a cold start reloads the content anyway
 * - pushPermissionGranted, pushToken — device/OS-derived, re-read at launch;
 *   the FCM token must never sit in persisted state. Their opposite is
 *   pushOptOut (#683), which IS persisted: it records user INTENT, not OS
 *   state, and an intent that evaporates on restart is not an opt-out.
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
    pushOptOut: state.pushOptOut,
  };
}

/**
 * Null out any persisted `lastMessageAt` that is not a finite number > 0 (#883).
 *
 * Rows are copied only when the value actually changes, so a healthy blob
 * hydrates the same object identities it always did.
 */
function sanitizePersistedConversations(
  saved: Record<string, unknown>,
): AppState['conversations'] {
  const out: Record<string, Conversation> = {};
  for (const [id, row] of Object.entries(saved)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      // Not a row shape at all — pass it through untouched; container-level
      // corruption is out of scope here (see the merge docstring).
      out[id] = row as Conversation;
      continue;
    }
    const raw = (row as { lastMessageAt?: unknown }).lastMessageAt;
    const normalized = typeof raw === 'number' ? maxTimestamp(raw, null) : null;
    out[id] =
      normalized === raw
        ? (row as Conversation)
        : ({ ...(row as Conversation), lastMessageAt: normalized });
  }
  return out;
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
 * Only notificationPrefs is floored PER KEY: it is the one persisted value with
 * a fixed key shape where per-key absence is representable. mutedTargets,
 * pendingMuteOps, threadLastViewedAt and the collections are open maps whose
 * empty default is already the correct base, and the scalars fall back to
 * current state via the top-level spread.
 *
 * Exported for the same reason as partializeAppState: persistence.test.ts must
 * assert the shipped function, never a copy that can drift.
 *
 * The guards exist because zustand calls merge(undefined, current) when storage
 * is empty and passes whatever JSON deserialized to when the blob is corrupt
 * (spreading a string or an array would splatter index keys into state).
 *
 * What is validated here, precisely (#692):
 * - notificationPrefs — per key: presence AND boolean type; unknown keys clamped
 *   out; the key set comes from DEFAULT_NOTIFICATION_PREFS.
 * - mutedTargets / pendingMuteOps — CONTAINER SHAPE ONLY (plain object; arrays,
 *   strings, null rejected — a string reached notificationSettingsSync's
 *   Object.keys/Object.entries reads before this guard). Entry VALUES are NOT
 *   validated: `{ pendingMuteOps: { t1: null } }` passes and still reaches the
 *   unguarded op.ownerUserId deref in that module. That residue is fail-open
 *   (worst case: nothing muted) and belongs to #687's input-validation cluster,
 *   deliberately NOT fixed in this store-layer merge.
 * - pushOptOut (#683) — TYPE validated (boolean), falling back to `current`.
 *   It gates push registration at launch, so a corrupt blob must not be able to
 *   hand `registerIfEnabled` a truthy non-boolean (silently killing push) or a
 *   falsy one (silently undoing an opt-out).
 * - conversations (#883) — ONE field, `lastMessageAt`, is normalized per row: a
 *   value that is not a finite number greater than 0 hydrates as null. It is
 *   the Chats sort key AND the floor every later bump compares against, so a
 *   corrupt or tampered blob holding NaN or Infinity would pin that row to the
 *   top of Chats for the life of the install — NaN fails every `<=` guard, so
 *   no later bump could lower it. The rest of the row (and the whole map's
 *   container shape) is still unvalidated.
 * - everything else — NOT validated. colorScheme/activeTab/soundEnabled,
 *   threadLastViewedAt, conversationIds, contacts and
 *   blockedUserIds/blockedUserProfiles ride the raw top-level spread. The
 *   allowlist above governs only WHICH keys are admitted, never their shape.
 *
 * The notificationPrefs floor is a two-stage fallback behind the saved value:
 * a saved BOOLEAN wins; else CURRENT wins — an empty or unreadable read must be
 * non-destructive (the property the "is non-destructive when storage is empty"
 * case guards; flooring straight from the constant would reset every pref to
 * all-on whenever getItem returns null after server truth had already landed);
 * else DEFAULT_NOTIFICATION_PREFS fills the key. That last stage is reachable
 * ONLY via a per-key hole — a key `current` itself lacks — never on a
 * whole-object empty read, which stage two already absorbs.
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
  //
  // The key set comes from DEFAULT_NOTIFICATION_PREFS, the same constant that
  // feeds PREF_KEYS (notificationSettingsSync.ts), not from a runtime object
  // whose completeness this loop would have to ASSUME. The `??` keeps the
  // ordering that makes an empty read non-destructive: `current` still wins
  // whenever it has a value, and the constant is reached only for a key
  // `current` itself lacks — the per-key hole the old current-keyed loop could
  // not even represent, because it iterated `current`'s own keys.
  const flooredPrefs: Partial<NotificationPrefs> = {};
  for (const k of Object.keys(DEFAULT_NOTIFICATION_PREFS) as (keyof NotificationPrefs)[]) {
    const savedValue = savedPrefs[k];
    flooredPrefs[k] =
      typeof savedValue === 'boolean'
        ? savedValue
        : (current.notificationPrefs[k] ?? DEFAULT_NOTIFICATION_PREFS[k]);
  }
  // Container-shape guard for the two open maps (#692). The allowlist admits
  // them; nothing checked they were objects, so a corrupt blob's string or array
  // reached state through the spread below — `Object.entries('abc')` yields
  // per-character entries whose ownerUserId is undefined, and every one of them
  // reads as a stale-owner queue entry to be deleted. Fallback target is
  // `current`, the same discipline as the prefs floor.
  //
  // Shape only: entry VALUES are not validated (see the docstring).
  const savedMutedTargets = isPlainObject(saved.mutedTargets) ? saved.mutedTargets : current.mutedTargets;
  const savedPendingMuteOps = isPlainObject(saved.pendingMuteOps) ? saved.pendingMuteOps : current.pendingMuteOps;
  // Per-row `lastMessageAt` normalization (#883). `maxTimestamp` is the only
  // function allowed to produce a stored recency value, and it never yields
  // NaN: anything not finite and > 0 — including a non-number a tampered blob
  // smuggled in — becomes null, which sorts to the bottom and is beatable by
  // the next real bump. Only this key is touched; every other field rides the
  // spread exactly as before.
  // Spread-applied only when the blob actually carried a conversations OBJECT,
  // so an absent or corrupt (string/array) value keeps its pre-#883 handling.
  const conversationsOverride = isPlainObject(saved.conversations)
    ? { conversations: sanitizePersistedConversations(saved.conversations) }
    : {};
  // The casts only re-narrow: flooredPrefs got every key of the typed constant
  // assigned above, and the two maps are either `current`'s own already-typed
  // value or an object whose shape (not entry types) was just checked.
  // Explicit key, not left to the `...saved` spread (#683): the spread would
  // hand a corrupt blob's non-boolean straight into the launch gate. Fallback
  // target is `current`, the same discipline as the prefs floor and the two
  // container guards — never the literal default.
  return {
    ...current,
    ...saved,
    ...conversationsOverride,
    notificationPrefs: flooredPrefs as NotificationPrefs,
    mutedTargets: savedMutedTargets as AppState['mutedTargets'],
    pendingMuteOps: savedPendingMuteOps as AppState['pendingMuteOps'],
    pushOptOut: typeof saved.pushOptOut === 'boolean' ? saved.pushOptOut : current.pushOptOut,
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
        merge: mergePersistedAppState,
      },
    ),
    { name: 'OrbitalStore', enabled: __DEV__ },
  ),
);
