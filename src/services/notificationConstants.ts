/**
 * Shared notification constants and pure functions.
 *
 * Used by both the foreground notification service and the background
 * message handler in index.js. Extracting these avoids duplicating the
 * titles map and channel config across two entry points.
 */

export const NOTIFICATION_TITLES: Record<string, string> = {
  new_thread: 'New thread in an Orbit',
  new_reply: 'New reply in a thread',
  new_dm: 'New direct message',
  orbit_invite: "You've been invited to an Orbit",
  member_joined: 'A new member joined your Orbit',
};

export const ANDROID_CHANNEL_ID = 'orbital-default';
export const ANDROID_CHANNEL_NAME = 'Orbital';

// ---------------------------------------------------------------------------
// Notification anchor — type-safe destination from push payload
// ---------------------------------------------------------------------------

export type NotificationAnchor =
  | { type: 'thread'; threadId: string; targetReplyId?: string }
  | { type: 'chat'; conversationId: string }
  | { type: 'joinOrbit'; code: string }
  | { type: 'threadsList' }
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
