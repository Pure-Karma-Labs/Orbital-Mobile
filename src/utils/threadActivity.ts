/**
 * Thread recency — the one place that decides "when did this thread last move"
 * and how two threads order against each other (#883).
 *
 * UNITS. Every timestamp here is already **epoch milliseconds**. Nothing in
 * this file converts units, and it deliberately does NOT import
 * `timestampUnits` / `toMillis`: that helper is confined to
 * `threadRepository` / `replyRepository`, the two readers of the seconds-unit
 * SQLite columns, and the `[timestamp-units-import-restricted]` security
 * invariant fails the build if that confinement is broken. By the time a value
 * reaches this file — from the store, the API mapper or a repository read — it
 * is ms or it is garbage, and "garbage" is handled explicitly below.
 *
 * NaN IS REACHABLE. `threadService` maps `new Date(response.createdAt).getTime()`
 * unguarded, so `Thread.createdAt` / `Thread.lastReplyAt` can be NaN in memory
 * on the API path. Every function here is total over NaN, ±Infinity, null,
 * undefined and non-positive values.
 *
 * THREE FUNCTIONS, TWO CONTRACTS — the split is the point:
 *
 * - `threadActivityAt` is for DISPLAY and COMPARISON ONLY. Its result is NEVER
 *   stored. It returns **NaN** when a thread has no usable timestamp at all,
 *   because that is exactly what the day-grouping path needs: `localDayKey(NaN)`
 *   is `''`, so the row opens no day group and closes none, and the #845 layout
 *   invariant (no duplicate `day-<key>`, no stray section separator) holds.
 *
 * - `maxTimestamp` is the ONLY function that may feed a **STORED**
 *   `lastReplyAt` / `lastMessageAt`. It NEVER returns NaN — it returns a valid
 *   ms value or `null`. Writing NaN into the store (or MMKV, or SQLite) is what
 *   latches a conversation to the top of a list forever, so the sanitising
 *   happens on the way IN, once, here.
 *
 * - `compareThreadsByActivityDesc` is a total order that never returns NaN, so
 *   `Array.prototype.sort` can never see an inconsistent comparator.
 */

import type { Thread } from '../types/store';

/** The fields the comparator needs. `Thread` from the store satisfies it. */
export type ThreadActivityInput = Pick<Thread, 'id' | 'createdAt' | 'lastReplyAt'>;

/**
 * A timestamp we are willing to render or order on: finite and strictly
 * positive. `0` is rejected on purpose — it is the "no value" sentinel the
 * SQLite read path produces for a non-finite stored value, not 1970.
 */
function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Compare two timestamps DESCENDING (newest first) with invalid values sorted
 * LAST. Never returns NaN: the `-Infinity`-rank trick would yield `NaN` for two
 * invalid operands, so the invalid cases are branched explicitly.
 */
function compareTimestampDesc(a: unknown, b: unknown): number {
  const aValid = isValidTimestamp(a);
  const bValid = isValidTimestamp(b);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/**
 * When a thread last moved: the newer of its `createdAt` and `lastReplyAt`.
 *
 * DISPLAY AND COMPARISON ONLY — never persist this value. Use
 * {@link maxTimestamp} for anything that is written back.
 *
 * @returns Epoch ms, or **NaN** when neither timestamp is valid. NaN is the
 *   contract, not an accident: `localDayKey(NaN) === ''` and
 *   `formatDayLabel(NaN) === ''`, which is how an unrenderable row joins
 *   whatever day group it lands in instead of splitting it (#845).
 *
 * @example
 *   threadActivityAt({ createdAt: 10, lastReplyAt: 20 })   // 20
 *   threadActivityAt({ createdAt: 30, lastReplyAt: null }) // 30
 *   threadActivityAt({ createdAt: 30, lastReplyAt: NaN })  // 30
 *   threadActivityAt({ createdAt: NaN, lastReplyAt: null }) // NaN
 */
export function threadActivityAt(t: Pick<Thread, 'createdAt' | 'lastReplyAt'>): number {
  const created = t?.createdAt;
  const replied = t?.lastReplyAt;
  const createdOk = isValidTimestamp(created);
  const repliedOk = isValidTimestamp(replied);

  if (createdOk && repliedOk) return created > replied ? created : replied;
  if (createdOk) return created;
  if (repliedOk) return replied;
  return NaN;
}

/**
 * Total ordering for a thread list: most recent activity first.
 *
 * Rules, in order:
 *   1. activity ({@link threadActivityAt}) descending;
 *   2. a thread with NO valid activity sorts LAST;
 *   3. ties break on `createdAt` descending, with an invalid `createdAt` last;
 *   4. then on `id`, ascending string compare, so the order is stable and
 *      deterministic across renders (two rows posted in the same millisecond
 *      must not swap places on re-sort).
 *
 * Never returns NaN, so `sort` always sees a consistent comparator.
 *
 * INVALID-VALUE POLICY DIFFERS FROM `replyTree.compareReplies`, deliberately.
 * `compareReplies` sorts replies ASCENDING (oldest first) and coerces a missing
 * or non-finite `createdAt` to `0` via its `sortKey`, which puts such a reply
 * FIRST — correct there, because a reply with no usable timestamp still has to
 * appear under its parent, and the oldest slot is the least disruptive place
 * for it. Here the list is DESCENDING and a thread's position *is* its claim to
 * attention, so a corrupt timestamp must not win the top of the list: it sorts
 * last instead. This file also rejects `0` as a timestamp, where
 * `compareReplies` uses `0` as its sentinel value.
 */
export function compareThreadsByActivityDesc(
  a: ThreadActivityInput,
  b: ThreadActivityInput,
): number {
  const byActivity = compareTimestampDesc(threadActivityAt(a), threadActivityAt(b));
  if (byActivity !== 0) return byActivity;

  const byCreated = compareTimestampDesc(a?.createdAt, b?.createdAt);
  if (byCreated !== 0) return byCreated;

  const aId = typeof a?.id === 'string' ? a.id : '';
  const bId = typeof b?.id === 'string' ? b.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * The newer of two timestamps, sanitised — the ONLY function allowed to produce
 * a value that gets STORED as `lastReplyAt` or `lastMessageAt`.
 *
 * An operand on EITHER side that is not finite, or not greater than 0, is
 * dropped rather than propagated: a single NaN or Infinity from a stale API
 * response, a tampered MMKV blob or an arithmetic slip would otherwise pin a
 * conversation to the top of the list permanently (NaN) or forever (Infinity).
 *
 * @returns Epoch ms, or `null` when both operands are dropped. NEVER NaN.
 *
 * @example
 *   maxTimestamp(5, 9)           // 9
 *   maxTimestamp(NaN, 123)       // 123
 *   maxTimestamp(NaN, null)      // null
 *   maxTimestamp(Infinity, 5)    // 5
 *   maxTimestamp(0, null)        // null
 *   maxTimestamp(-10, undefined) // null
 */
export function maxTimestamp(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const aOk = isValidTimestamp(a);
  const bOk = isValidTimestamp(b);

  if (aOk && bOk) return a > b ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return null;
}
