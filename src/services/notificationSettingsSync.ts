/**
 * Notification settings sync (#449).
 *
 * The single network owner for notification preferences and per-target mutes —
 * the notificationSlice actions it calls are pure store mutations.
 *
 * Sync model (plan D4): server-authoritative overwrite, gated per call. The two
 * GETs run under Promise.allSettled so one failing endpoint never clobbers the
 * other half of the state, and a rejected half leaves the persisted state
 * untouched (it is NEVER reset to defaults on failure — that would silently
 * unmute everything on a flaky network).
 *
 * Mutations are optimistic per key: the store flips first so the UI is
 * instant, then the API call either confirms (applying the server's response
 * body when it sends one) or rolls that one key back. Errors that are merely
 * connectivity ("you are offline") do not raise an Alert — the next sync
 * reconciles. An offline replay queue is a filed follow-up.
 */

import { Alert } from 'react-native';
import { useAppStore } from '../stores/useAppStore';
import {
  getNotificationMutes,
  getNotificationPrefs,
  muteTargetApi,
  unmuteTargetApi,
  updateNotificationPrefs,
} from './api/notificationSettings';
import { NetworkError } from './api/errors';
import type {
  MuteTargetType,
  NotificationMute,
  NotificationPrefs,
} from '../types/api';

const PREF_KEYS: (keyof NotificationPrefs)[] = [
  'newThread',
  'newReply',
  'newDm',
  'memberJoined',
];

const MUTE_TARGET_TYPES: MuteTargetType[] = ['thread', 'group'];

/**
 * Keep only known boolean pref keys.
 *
 * Guards the store against a partial or malformed response writing `undefined`
 * over a real boolean (which would read as "off" at the suppression check).
 */
function sanitizePrefs(raw: unknown): Partial<NotificationPrefs> {
  if (raw === null || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<NotificationPrefs> = {};
  for (const key of PREF_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean;
  }
  return out;
}

/** Build the store's muted-target map from the server's mute rows. */
function toMutedTargets(mutes: NotificationMute[]): Record<string, MuteTargetType> {
  const out: Record<string, MuteTargetType> = {};
  for (const mute of mutes) {
    if (
      typeof mute?.targetId === 'string' &&
      mute.targetId.length > 0 &&
      MUTE_TARGET_TYPES.includes(mute.targetType)
    ) {
      out[mute.targetId] = mute.targetType;
    }
  }
  return out;
}

/** True for failures that are purely connectivity — not worth an Alert. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof NetworkError;
}

function warn(scope: string, error: unknown): void {
  if (__DEV__) {
    const name = error instanceof Error ? error.name : 'unknown error';
    console.warn(`[NotificationSettings] ${scope} failed: ${name}`);
  }
}

/** Surface a failure to the user unless it is a plain connectivity error. */
function alertUnlessOffline(error: unknown, fallback: string): void {
  if (isNetworkFailure(error)) return;
  const message = error instanceof Error && error.message ? error.message : fallback;
  Alert.alert('Notification settings', message);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Pull both halves of the notification settings and overwrite local state.
 *
 * Called fire-and-forget beside syncBlockedUsers after login and after key
 * recovery. Never throws — callers attach .catch() for logging only.
 */
export async function syncNotificationSettings(): Promise<void> {
  const [prefsResult, mutesResult] = await Promise.allSettled([
    getNotificationPrefs(),
    getNotificationMutes(),
  ]);

  const store = useAppStore.getState();

  if (prefsResult.status === 'fulfilled') {
    // The GET always returns the full key set, so a merge is an overwrite.
    store.setNotificationPrefs(sanitizePrefs(prefsResult.value));
  } else {
    warn('prefs sync', prefsResult.reason);
  }

  if (mutesResult.status === 'fulfilled') {
    const mutes = Array.isArray(mutesResult.value?.mutes) ? mutesResult.value.mutes : [];
    store.setMutedTargets(toMutedTargets(mutes));
  } else {
    warn('mutes sync', mutesResult.reason);
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Toggle the mute state of one target (thread id or group id).
 *
 * Optimistic: the store flips immediately, then rolls back that single target
 * if the API call rejects. Resolves to the mute state now in effect.
 */
export async function toggleMute(
  targetId: string,
  targetType: MuteTargetType,
): Promise<boolean> {
  const wasMuted = useAppStore.getState().mutedTargets[targetId] !== undefined;
  const previousType = useAppStore.getState().mutedTargets[targetId];

  if (wasMuted) {
    useAppStore.getState().removeMutedTarget(targetId);
    try {
      await unmuteTargetApi(targetId);
      return false;
    } catch (error) {
      // Roll back only this target — a concurrent sync may have changed others.
      useAppStore.getState().addMutedTarget(targetId, previousType ?? targetType);
      warn('unmute', error);
      alertUnlessOffline(error, 'Could not unmute. Please try again.');
      return true;
    }
  }

  useAppStore.getState().addMutedTarget(targetId, targetType);
  try {
    await muteTargetApi(targetId, targetType);
    return true;
  } catch (error) {
    useAppStore.getState().removeMutedTarget(targetId);
    warn('mute', error);
    alertUnlessOffline(error, 'Could not mute. Please try again.');
    return false;
  }
}

/**
 * Set one notification preference.
 *
 * Optimistic per key: flips locally, PUTs just that key, then applies the
 * server's post-update pref set when the response carries one. On rejection
 * only that key is rolled back.
 */
export async function setPref(
  key: keyof NotificationPrefs,
  value: boolean,
): Promise<void> {
  const previous = useAppStore.getState().notificationPrefs[key];
  if (previous === value) return;

  useAppStore.getState().setNotificationPrefs({ [key]: value });

  try {
    const response = await updateNotificationPrefs({ [key]: value });
    const confirmed = sanitizePrefs(response);
    if (Object.keys(confirmed).length > 0) {
      useAppStore.getState().setNotificationPrefs(confirmed);
    }
  } catch (error) {
    useAppStore.getState().setNotificationPrefs({ [key]: previous });
    warn('pref update', error);
    alertUnlessOffline(error, 'Could not save that setting. Please try again.');
  }
}
