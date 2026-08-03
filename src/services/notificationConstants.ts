/**
 * Shared notification constants and pure functions.
 *
 * Used by both the foreground notification service and the background
 * message handler in index.js. Extracting these avoids duplicating the
 * titles map and channel config across two entry points.
 *
 * IMPORTANT: this module is imported by index.js at bundle load — BEFORE
 * bootstrap, before encrypted MMKV is open. It must stay free of store,
 * MMKV, database, and API imports, and every export must be a constant or a
 * pure function of its arguments. Type-only imports are fine (erased).
 */

import type { NotificationPrefs } from '../types/api';

export const NOTIFICATION_TITLES: Record<string, string> = {
  new_thread: 'New thread in an Orbit',
  new_reply: 'New reply in a thread',
  new_dm: 'New direct message',
  orbit_invite: "You've been invited to an Orbit",
  member_joined: 'A new member joined your Orbit',
  // #539: fixes the Android background title gap — the server's titleMap is
  // iOS-only (APNs alert.title); Android relies entirely on this client map.
  identity_key_reset: 'Security alert',
};

export const ANDROID_CHANNEL_ID = 'orbital-default';
export const ANDROID_CHANNEL_NAME = 'Orbital';

// ---------------------------------------------------------------------------
// Suppressible-type registry (#449, plan D0)
// ---------------------------------------------------------------------------

/**
 * Push types that per-type preferences and per-target mutes may suppress.
 *
 * Mirrors the backend registry in src/config/notificationTypes.js. Two types
 * are deliberately absent:
 * - `identity_key_reset` — a security tripwire; never suppressible. The
 *   carve-out is structural twice over: it routes via the backend's sendPush
 *   path (which never filters) AND is not in this allowlist, so even a future
 *   variant carrying a gid could not be muted.
 * - `orbit_invite` — dead type, no producer.
 */
export const SUPPRESSIBLE_TYPES = [
  'new_thread',
  'new_reply',
  'new_dm',
  'member_joined',
] as const;

export type SuppressibleType = (typeof SUPPRESSIBLE_TYPES)[number];

/** Narrowing guard for arbitrary payload `t` values. */
export function isSuppressibleType(type: string | undefined): type is SuppressibleType {
  return (SUPPRESSIBLE_TYPES as readonly string[]).includes(type as string);
}

/**
 * Push type -> the preference key that gates it.
 *
 * NOTE: this is the *nominal* mapping. DM conversations in this app are groups
 * with group_type='dm' whose traffic fires `new_thread`/`new_reply`, so the
 * effective key for a payload whose gid resolves to a direct conversation is
 * `newDm` regardless of `t` (plan D5). notificationService applies that
 * override; this map stays a pure type->key table so it can live here beside
 * the background handler's imports.
 */
export const PREF_KEY_BY_TYPE: Record<SuppressibleType, keyof NotificationPrefs> = {
  new_thread: 'newThread',
  new_reply: 'newReply',
  new_dm: 'newDm',
  member_joined: 'memberJoined',
};

// ---------------------------------------------------------------------------
// Collapse key (#449, plan D9)
// ---------------------------------------------------------------------------

/**
 * Notification collapse key for a push payload, or null when the notification
 * must NOT collapse.
 *
 * Replies to one thread replace each other in the tray instead of stacking:
 * thread-scoped types collapse on `tid`, conversation-scoped types on `gid`.
 * `identity_key_reset` returns null — security alerts must stack.
 *
 * Pure function of the payload, so it is safe in the pre-bootstrap background
 * handler. On Android this becomes notifee's `id`; on iOS the backend sets
 * `apns-collapse-id` from the same derivation.
 */
export function collapseKeyForPayload(data: Record<string, string>): string | null {
  const { t, tid, gid } = data;
  switch (t) {
    case 'new_reply':
    case 'new_thread':
      return tid && tid.length > 0 && tid.length <= 255 ? tid : null;
    case 'new_dm':
    case 'member_joined':
      return gid && gid.length > 0 && gid.length <= 255 ? gid : null;
    default:
      // identity_key_reset (must stack), orbit_invite, unknown types.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Notification anchor — type-safe destination from push payload
// ---------------------------------------------------------------------------

export type NotificationAnchor =
  | { type: 'thread'; threadId: string; targetReplyId?: string }
  | { type: 'chat'; conversationId: string }
  | { type: 'joinOrbit'; code: string }
  | { type: 'threadsList' }
  | { type: 'settings' }
  | null;

/**
 * Map a raw push payload `data` object to a typed navigation anchor.
 *
 * Returns null if the payload is malformed, missing required fields, or
 * contains suspiciously long IDs (>255 chars — possible injection).
 */
export function resolveAnchor(data: Record<string, string>): NotificationAnchor {
  const { t, gid, tid, rid, code } = data;
  if (!t || typeof t !== 'string') return null;

  switch (t) {
    case 'new_thread':
      return tid && tid.length > 0 && tid.length <= 255
        ? { type: 'thread', threadId: tid }
        : null;
    case 'new_reply':
      if (!tid || tid.length === 0 || tid.length > 255) return null;
      return {
        type: 'thread',
        threadId: tid,
        targetReplyId: rid && rid.length > 0 && rid.length <= 255 ? rid : undefined,
      };
    case 'new_dm':
      return gid && gid.length > 0 && gid.length <= 255
        ? { type: 'chat', conversationId: gid }
        : null;
    case 'orbit_invite':
      return code && code.length > 0 && code.length <= 255
        ? { type: 'joinOrbit', code }
        : null;
    case 'member_joined':
      return { type: 'threadsList' };
    case 'identity_key_reset':
      // No IDs in the payload ({t, v} only) — tap always lands on Settings.
      // The conflict-flag state mutation for this type happens in
      // notificationService (foreground onMessage / navigateFromNotification),
      // not here — this function stays a pure payload -> anchor mapper.
      return { type: 'settings' };
    default:
      return null;
  }
}

/**
 * Generate a dedup key for a push payload, or null if dedup is not applicable.
 *
 * Used by both foreground and background handlers to prevent displaying
 * duplicate notifications for the same event (e.g., WS + push race).
 */
export function dedupKeyForPayload(data: Record<string, string>): string | null {
  const { t, tid, rid, code } = data;
  switch (t) {
    case 'new_thread': return tid ? `thread:${tid}` : null;
    case 'new_reply': return rid ? `reply:${rid}` : null;
    // new_dm: skip dedup — keyed by conversation, not message; would collapse sequential DMs
    case 'orbit_invite': return code ? `invite:${code}` : null;
    // member_joined: skip dedup — no unique event ID, would collapse distinct joins
    default: return null;
  }
}
