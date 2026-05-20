import type { StateCreator } from 'zustand';
import type { AppState, NotificationSlice } from '../../types/store';

export const createNotificationSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  NotificationSlice
> = (set) => ({
  // Initial state
  pushPermissionGranted: false,
  pushToken: null,

  // Actions
  setPushPermission: (granted) =>
    set({ pushPermissionGranted: granted }, false, 'notification/setPushPermission'),

  setPushToken: (token) =>
    set({ pushToken: token }, false, 'notification/setPushToken'),
});
