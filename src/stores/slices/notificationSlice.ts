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

  resetNotificationSettings: () =>
    set(
      { notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS }, mutedTargets: {} },
      false,
      'notification/resetNotificationSettings',
    ),
});
