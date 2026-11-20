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

  const sorted = [...threads].sort(compareThreadsByActivityDesc);

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
