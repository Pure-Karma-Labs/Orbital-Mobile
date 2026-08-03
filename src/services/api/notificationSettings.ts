/**
 * Notification settings API service (#449).
 *
 * Two resources under /api/users/me:
 * - notification-prefs: one row per user of per-type booleans (no row = all on)
 * - notification-mutes: per-target mute rows (thread ids and group ids)
 *
 * Wire format is snake_case in both directions — client.ts converts request
 * bodies via camelToSnake and responses via snakeToCamel, so everything in
 * this module is camelCase.
 *
 * These endpoints carry IDs only — never content — so the E2EE posture is
 * unchanged.
 */

import { request } from './client';
import type {
  AddNotificationMuteRequest,
  MuteTargetType,
  NotificationMutesResponse,
  NotificationPrefsResponse,
  UpdateNotificationPrefsRequest,
} from '../../types/api';

const PREFS_PATH = '/api/users/me/notification-prefs';
const MUTES_PATH = '/api/users/me/notification-mutes';

/** GET the full pref key set. Absent server row yields all-true defaults. */
export function getNotificationPrefs(): Promise<NotificationPrefsResponse> {
  return request<NotificationPrefsResponse>({
    method: 'GET',
    path: PREFS_PATH,
  });
}

/**
 * PUT a partial pref patch. Omitted keys are left unchanged server-side.
 * Returns the full post-update pref set.
 */
export function updateNotificationPrefs(
  prefs: UpdateNotificationPrefsRequest,
): Promise<NotificationPrefsResponse> {
  return request<NotificationPrefsResponse>({
    method: 'PUT',
    path: PREFS_PATH,
    body: prefs,
  });
}

/** GET every mute row for the authenticated user. */
export function getNotificationMutes(): Promise<NotificationMutesResponse> {
  return request<NotificationMutesResponse>({
    method: 'GET',
    path: MUTES_PATH,
  });
}

/**
 * PUT a mute row for a target. Idempotent — re-muting an already-muted target
 * succeeds. 404 when the target does not exist or the caller is not a member
 * (deliberately the same status — no existence oracle).
 *
 * The response body is intentionally untyped: nothing in the client depends on
 * it, and typing it would be speculative.
 */
export function muteTargetApi(
  targetId: string,
  targetType: MuteTargetType,
): Promise<void> {
  const body: AddNotificationMuteRequest = { targetType };
  return request<void>({
    method: 'PUT',
    path: `${MUTES_PATH}/${encodeURIComponent(targetId)}`,
    body,
  });
}

/** DELETE a mute row. 204 for any valid UUID, hit or miss (idempotent). */
export function unmuteTargetApi(targetId: string): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `${MUTES_PATH}/${encodeURIComponent(targetId)}`,
  });
}
