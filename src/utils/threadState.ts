/**
 * Per-thread unread state computation (#329).
 *
 * Shared by ThreadsScreen (orbit thread list) and ChatDetailScreen
 * (DM thread list).
 */

import type { Thread } from '../types/store';
import { threadActivityAt } from './threadActivity';

/**
 * Compute per-thread unread state.
 *
 * A thread is 'unread' when its latest activity (`threadActivityAt`: the newer
 * of createdAt and lastReplyAt) is more recent than both:
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
  const threadActivity = threadActivityAt(thread);
  const viewedAt = threadLastViewedAt[thread.id] ?? 0;
  const watermark = Math.max(viewedAt, lastReadAtSnapshot ?? 0);

  // A thread with NO valid timestamp has NaN activity, and `NaN > watermark` is
  // false — so it reports 'read'. That is the deliberate choice: an
  // unrenderable row already shows no day header and no clock time (#845), and
  // a permanent unread dot that no amount of reading can clear is worse than a
  // missed one. The inline `Math.max(createdAt, lastReplyAt ?? 0)` this
  // replaced agreed on that case only because NaN poisons Math.max; it differed
  // on the mixed ones (a NaN createdAt beside a real lastReplyAt was 'read',
  // and an Infinity lastReplyAt was permanently 'unread').
  if (threadActivity > watermark) {
    return 'unread';
  }
  return 'read';
}
