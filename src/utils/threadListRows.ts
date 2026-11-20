/**
 * Day-grouped row model for the two thread LIST screens (#923).
 *
 * ThreadsScreen (an orbit's threads) and ChatDetailScreen (a DM's messages)
 * carried byte-identical copies of this builder. Paging makes the list long —
 * 5–10k rows is a realistic imported orbit — so the rebuild cost is now
 * something to measure, and a benchmark cannot measure two copies. Extracted
 * verbatim: the output of this function is exactly what both screens produced
 * before, including the empty-list short circuit and the `''` day-key rule.
 *
 * ThreadDetailScreen is NOT a consumer: its rows are replies in tree order and
 * come from `replyTree.ts`.
 */

import type { Thread } from '../types/store';
import { compareThreadsByActivityDesc, threadActivityAt } from './threadActivity';
import { formatDayLabel, localDayKey } from './formatPostTimestamp';

/** A day heading — "Today", "June 1, 2014". */
export type DaySeparatorRow = { type: 'day'; label: string; key: string };
/** The rule BETWEEN two day groups; never before the first. */
export type SectionSeparatorRow = { type: 'section'; key: string };
/** One thread (an orbit thread, or a DM message). */
export type ThreadRow = { type: 'thread'; thread: Thread; key: string };
export type ListRow = DaySeparatorRow | SectionSeparatorRow | ThreadRow;

/**
 * Sort by most recent activity (the newer of `createdAt` and `lastReplyAt`)
 * descending, then insert a day heading whenever the local day changes.
 *
 * The shared comparator is total: it never returns NaN, it sorts a thread with
 * no valid timestamp last, and it breaks ties on `createdAt` then id so the
 * order is stable across re-sorts (#883). Grouping and labelling both run off
 * ACTIVITY, so the day headers agree with the row order; each row's own clock
 * time still shows its creation time.
 */
export function buildListRows(threads: readonly Thread[]): ListRow[] {
  if (threads.length === 0) {
    return [];
  }

  return groupByDay([...threads].sort(compareThreadsByActivityDesc));
}

/** The day-grouping half, over an ALREADY sorted list. */
function groupByDay(sorted: readonly Thread[]): ListRow[] {
  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    const activityTime = threadActivityAt(thread);
    const dayKey = localDayKey(activityTime);
    // An unrenderable timestamp has no day, so it opens no group and closes
    // none: it joins whatever group it lands in. Letting '' through would both
    // render a bare `───  ───` and split a real day in two, re-emitting its
    // `day-<key>` (a duplicate FlatList key) and an extra section row.
    if (dayKey !== '' && dayKey !== lastDayKey) {
      if (lastDayKey !== null) {
        rows.push({ type: 'section', key: `section-${groupIndex}` });
        groupIndex++;
      }
      rows.push({
        type: 'day',
        label: formatDayLabel(activityTime),
        key: `day-${dayKey}`,
      });
      lastDayKey = dayKey;
    }
    rows.push({ type: 'thread', thread, key: `thread-${thread.id}` });
  }

  return rows;
}

/**
 * A per-screen cache in front of {@link buildListRows} (#923 "Bounds").
 *
 * The benchmark (`scripts/bench/threadListPaging.bench.js`, desktop Hermes,
 * a LOWER bound against a device) put one rebuild at 10,000 rows at ~80 ms,
 * against a 50 ms budget — and 69 of those 80 ms are the `sort`, because
 * Hermes runs a JS comparator ~20x slower than V8 does. Every write to the
 * `threads` map produces a new array for this conversation, so without a cache
 * a single arriving reply re-sorts the whole walked list.
 *
 * Three paths, in order:
 *
 * 1. **Unchanged** — same length, every element the same OBJECT. Returns the
 *    previous rows array, allocating nothing. This is the common re-render:
 *    the store replaced its `threads` map over rows this list does not hold.
 * 2. **Appended** — the previous input is a reference-prefix of the new one.
 *    Sorts only the appended rows and MERGES them into the kept order.
 *    `compareThreadsByActivityDesc` is a strict total order on distinct ids
 *    (activity, then `createdAt`, then id), so the sorted permutation is
 *    unique and a merge of two sorted runs is byte-for-byte the array a full
 *    sort would have produced.
 *
 *    This is what walk pages 2..n produce: they are requested with an
 *    exclusive `before` cursor, so every row is a new id, and `mergeThreads`
 *    appends those ids while leaving the existing entities' identities alone.
 *    The walk's FIRST page is cursorless and overlaps the head by
 *    construction, and `fetchAndApplyThreadPage` maps every row in a page to a
 *    fresh object — so that one page replaces identities mid-array and takes
 *    path 3 instead. It is the cheapest rebuild there is (the list is still
 *    head-sized), which is why this is left alone.
 * 3. **Otherwise** — a full rebuild, exactly as before. A reply landing in a
 *    walked list takes this path; it costs what it cost before this cache.
 *
 * Deliberately NOT keyed on the conversation id: the paths are content tests,
 * so a conversation switch simply falls through to a full rebuild.
 *
 * TWO THINGS THIS RELIES ON, neither of which it can check:
 * - `Thread` objects are immutable once stored. Every path compares by
 *   IDENTITY, so an in-place `thread.lastReplyAt = …` on a held object would
 *   leave path 1 returning unchanged rows (no re-render at all) and path 2
 *   merging against an order that is no longer sorted. The store is
 *   copy-on-write throughout today.
 * - The caller does not mutate the returned array: path 1 hands back the
 *   cache's own `lastRows`. Both screens pass it straight to a FlatList.
 */
export interface ThreadListRowsCache {
  (threads: readonly Thread[]): ListRow[];
}

export function createThreadListRowsCache(): ThreadListRowsCache {
  let lastInput: readonly Thread[] = [];
  let lastSorted: Thread[] = [];
  let lastRows: ListRow[] = [];

  return function rowsFor(threads: readonly Thread[]): ListRow[] {
    if (threads.length === 0) {
      lastInput = threads;
      lastSorted = [];
      lastRows = [];
      return lastRows;
    }

    // Path 1 and path 2 share one scan: walk the previous input against the
    // new one and stop at the first difference.
    const prefixLength = Math.min(lastInput.length, threads.length);
    let i = 0;
    while (i < prefixLength && lastInput[i] === threads[i]) i++;

    if (i === lastInput.length && i === threads.length) {
      lastInput = threads;
      return lastRows;
    }

    if (i === lastInput.length && i > 0) {
      const appended = threads.slice(i).sort(compareThreadsByActivityDesc);
      lastSorted = mergeSorted(lastSorted, appended);
      lastRows = groupByDay(lastSorted);
      lastInput = threads;
      return lastRows;
    }

    lastSorted = [...threads].sort(compareThreadsByActivityDesc);
    lastRows = groupByDay(lastSorted);
    lastInput = threads;
    return lastRows;
  };
}

/** Merge two runs already in `compareThreadsByActivityDesc` order. */
function mergeSorted(left: readonly Thread[], right: readonly Thread[]): Thread[] {
  const out: Thread[] = new Array<Thread>(left.length + right.length);
  let a = 0;
  let b = 0;
  let o = 0;
  while (a < left.length && b < right.length) {
    out[o++] = compareThreadsByActivityDesc(left[a], right[b]) <= 0 ? left[a++] : right[b++];
  }
  while (a < left.length) out[o++] = left[a++];
  while (b < right.length) out[o++] = right[b++];
  return out;
}
