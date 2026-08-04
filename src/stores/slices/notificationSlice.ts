import type { StateCreator } from 'zustand';
import type { AppState, NotificationSlice } from '../../types/store';
import type { NotificationPrefs } from '../../types/api';

/**
 * Default per-type preferences: everything on.
 *
 * Mirrors the backend, where a missing notification_prefs row means "all on"
 * (no backfill — see plan D1).
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  newThread: true,
  newReply: true,
  newDm: true,
  memberJoined: true,
};

/**
 * Defensive backstop on the persisted replay queue (#678).
 *
 * Per-target coalescing already bounds the queue by distinct targets; this caps
 * the pathological case. Lives here, not in notificationSettingsSync, because
 * the cap is enforced by `applyMuteIntent` — the slice must not import the
 * network module, and one definition cannot drift from the code that applies it.
 */
export const MAX_PENDING_MUTE_OPS = 200;

/**
 * Notification slice.
 *
 * Every action here is a PURE store mutation. Network calls live exclusively in
 * notificationSettingsSync.ts — keeping them out of the slice is what makes the
 * optimistic-update-then-rollback pattern possible (#449, plan D4).
 */
export const createNotificationSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  NotificationSlice
> = (set) => ({
  // Initial state
  pushPermissionGranted: false,
  pushToken: null,
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
  mutedTargets: {},
  pendingMuteOps: {},

  // Actions
  setPushPermission: (granted) =>
    set({ pushPermissionGranted: granted }, false, 'notification/setPushPermission'),

  setPushToken: (token) =>
    set({ pushToken: token }, false, 'notification/setPushToken'),

  setNotificationPrefs: (prefs) =>
    set(
      (state) => ({ notificationPrefs: { ...state.notificationPrefs, ...prefs } }),
      false,
      'notification/setNotificationPrefs',
    ),

  setMutedTargets: (targets) =>
    set({ mutedTargets: { ...targets } }, false, 'notification/setMutedTargets'),

  addMutedTarget: (targetId, targetType) =>
    set(
      (state) => ({ mutedTargets: { ...state.mutedTargets, [targetId]: targetType } }),
      false,
      'notification/addMutedTarget',
    ),

  removeMutedTarget: (targetId) =>
    set(
      (state) => {
        if (state.mutedTargets[targetId] === undefined) return {};
        const next = { ...state.mutedTargets };
        delete next[targetId];
        return { mutedTargets: next };
      },
      false,
      'notification/removeMutedTarget',
    ),

  applyMuteIntent: (targetId, op) =>
    set(
      (state) => {
        const mutedTargets = { ...state.mutedTargets };
        if (op.muted) mutedTargets[targetId] = op.targetType;
        else delete mutedTargets[targetId];

        // At cap, a target the queue has never seen is flipped but not
        // enqueued — the caller's seeded runner still issues the request.
        const known = state.pendingMuteOps[targetId] !== undefined;
        if (!known && Object.keys(state.pendingMuteOps).length >= MAX_PENDING_MUTE_OPS) {
          return { mutedTargets };
        }

        return {
          mutedTargets,
          pendingMuteOps: { ...state.pendingMuteOps, [targetId]: op },
        };
      },
      false,
      'notification/applyMuteIntent',
    ),

  clearPendingMuteOp: (targetId) =>
    set(
      (state) => {
        if (state.pendingMuteOps[targetId] === undefined) return {};
        const next = { ...state.pendingMuteOps };
        delete next[targetId];
        return { pendingMuteOps: next };
      },
      false,
      'notification/clearPendingMuteOp',
    ),

  clearPendingMuteOps: (targetIds) =>
    set(
      (state) => {
        const present = targetIds.filter((id) => state.pendingMuteOps[id] !== undefined);
        if (present.length === 0) return {};
        const next = { ...state.pendingMuteOps };
        for (const id of present) delete next[id];
        return { pendingMuteOps: next };
      },
      false,
      'notification/clearPendingMuteOps',
    ),

  bumpPendingMuteAttempts: (targetId) =>
    set(
      (state) => {
        const op = state.pendingMuteOps[targetId];
        if (op === undefined) return {};
        return {
          pendingMuteOps: {
            ...state.pendingMuteOps,
            [targetId]: { ...op, attempts: op.attempts + 1 },
          },
        };
      },
      false,
      'notification/bumpPendingMuteAttempts',
    ),

  resetNotificationSettings: () =>
    set(
      {
        notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
        mutedTargets: {},
        pendingMuteOps: {},
      },
      false,
      'notification/resetNotificationSettings',
    ),
});
