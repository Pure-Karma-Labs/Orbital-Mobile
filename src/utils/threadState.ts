/**
 * Per-thread unread state computation (#329).
 *
 * Shared by ThreadsScreen (orbit thread list) and ChatDetailScreen
 * (DM thread list).
 */

import type { Thread } from '../types/store';

/**
 * Compute per-thread unread state.
 *
 * A thread is 'unread' when its latest activity (createdAt or lastReplyAt) is
 * more recent than both:
 *   - the user's last view of that specific thread (threadLastViewedAt)
 *   - the server-side lastReadAt watermark for the conversation (snapshot)
 *
 * The lastReadAt snapshot MUST be captured once on focus and held as a ref
 * for the entire focus session. Reading it live would cause the debounced
 * markConversationReadEverywhere to flip all threads to 'read' seconds later.
 */
export function getThreadState(
  thread: Thread,
  threadLastViewedAt: Record<string, number>,
  lastReadAtSnapshot: number | null,
): 'read' | 'active' | 'unread' {
  const threadActivity = Math.max(thread.createdAt, thread.lastReplyAt ?? 0);
  const viewedAt = threadLastViewedAt[thread.id] ?? 0;
  const watermark = Math.max(viewedAt, lastReadAtSnapshot ?? 0);

  if (threadActivity > watermark) {
    return 'unread';
  }
  return 'read';
}
