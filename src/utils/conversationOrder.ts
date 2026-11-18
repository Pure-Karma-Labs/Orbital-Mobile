/**
 * Conversation list order — the one place that decides how two conversations
 * rank against each other (#927).
 *
 * The rule is the one `ChatsListScreen` has always applied to DMs:
 * `lastMessageAt ?? createdAt`, newest first. The store's own sort used a bare
 * `lastMessageAt ?? 0`, which is why an orbit whose only content is an IMPORT
 * sank to the bottom of the orbit list and stayed there: the server reports
 * `last_message_at: null` for such an orbit by design (imported content never
 * moves it, Backend #317), and the client turned that null into 1970.
 *
 * `createdAt` on a conversation row is the member's own `joined_at` — never
 * null, and never the back-dated import date, which is exactly why the newest
 * served thread `created_at` is NOT the fallback (it would be 2015 for a real
 * archive and sort last just the same).
 *
 * SORT-ONLY. Nothing here is ever written back: a conversation whose
 * `lastMessageAt` is null keeps it null, and `bumpLastMessageAt` keeps its own
 * comparison. The fallback exists to place a row, not to invent a timestamp.
 *
 * NaN-safe through `maxTimestamp`, the sanitising helper from
 * `threadActivity.ts`: a non-finite or non-positive value on either field is
 * dropped rather than propagated, so `sort` can never see a NaN comparison.
 */

import { maxTimestamp } from './threadActivity';
import type { Conversation } from '../types/store';

/** The fields the comparator needs. `Conversation` from the store satisfies it. */
export type ConversationOrderInput = Pick<Conversation, 'lastMessageAt' | 'createdAt'>;

/**
 * The timestamp a conversation sorts by: its last message, else its creation
 * (join) time, else `0`.
 *
 * COALESCE, not max — matching what `ChatsListScreen` already showed, so this
 * change moves no DM. A conversation with a valid `lastMessageAt` sorts by it
 * even when `createdAt` is newer.
 */
function conversationRecencyAt(c: ConversationOrderInput): number {
  // `maxTimestamp(x, null)` is "x if it is a usable ms timestamp, else null".
  const lastMessage = maxTimestamp(c?.lastMessageAt, null);
  if (lastMessage !== null) return lastMessage;
  return maxTimestamp(c?.createdAt, null) ?? 0;
}

/**
 * Most recent conversation first. Never returns NaN: both operands are finite
 * by construction.
 */
export function compareConversationsByRecencyDesc(
  a: ConversationOrderInput,
  b: ConversationOrderInput,
): number {
  return conversationRecencyAt(b) - conversationRecencyAt(a);
}
