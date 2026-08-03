/**
 * Mute actions for threads and conversations (#449, plan D6).
 *
 * Screen-level hook. The returned callbacks are stable for the lifetime of the
 * screen — memoized list rows receive them as props, so any identity churn here
 * would re-render every visible row on every store update.
 *
 * Stability is why the current mute state is read from `getState()` at press
 * time instead of being subscribed to: the menu only needs to know "muted or
 * not" the instant the user opens it.
 *
 * The Alert.alert action-list idiom matches useAuthorActions (block/report) —
 * one native menu style for every row-level action in the app.
 */

import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useAppStore } from '../stores';
import { toggleMute } from '../services/notificationSettingsSync';
import type { MuteTargetType } from '../types/api';

export interface UseMuteActionsResult {
  /**
   * Open the mute/unmute action list for one target.
   *
   * @param targetId   thread id ('thread') or group/conversation id ('group')
   * @param targetType which mute row the server should write
   * @param label      Alert title — the thread title or conversation name
   */
  showMuteMenu: (targetId: string, targetType: MuteTargetType, label: string) => void;
  /** Toggle without confirmation — for the detail-header bells. */
  toggleMuteFor: (targetId: string, targetType: MuteTargetType) => void;
}

export function useMuteActions(): UseMuteActionsResult {
  const toggleMuteFor = useCallback((targetId: string, targetType: MuteTargetType) => {
    // Deliberately not awaited: toggleMute is optimistic (the store has already
    // flipped by the time it resolves), never throws, and owns its own Alert.
    toggleMute(targetId, targetType);
  }, []);

  const showMuteMenu = useCallback(
    (targetId: string, targetType: MuteTargetType, label: string) => {
      const isMuted = useAppStore.getState().mutedTargets[targetId] != null;

      Alert.alert(
        label,
        isMuted
          ? 'Notifications are muted. New activity still arrives in the app.'
          : 'Stop push notifications for this. New activity still arrives in the app.',
        [
          {
            text: isMuted ? 'Unmute notifications' : 'Mute notifications',
            onPress: () => {
              toggleMute(targetId, targetType);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    },
    [],
  );

  return { showMuteMenu, toggleMuteFor };
}
