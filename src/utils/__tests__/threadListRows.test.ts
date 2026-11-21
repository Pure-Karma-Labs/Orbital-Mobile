/**
 * `buildListRows` — the day-grouped row model both list screens render (#923).
 *
 * The function was lifted out of ThreadsScreen/ChatDetailScreen unchanged, so
 * these cases pin the behaviour the two screens' own suites already assert
 * through the rendered tree: order, one heading per day, a section rule only
 * BETWEEN groups, and an unrenderable timestamp that opens no group.
 */

import { buildListRows, createThreadListRowsCache } from '../threadListRows';
import { makeThread } from '../../testUtils/makeThread';
import type { Thread } from '../../types/store';

/** 2024-06-01T12:00:00Z and 2024-06-02T12:00:00Z — midday, so no TZ flips. */
const DAY_1 = Date.UTC(2024, 5, 1, 12, 0, 0);
const DAY_2 = Date.UTC(2024, 5, 2, 12, 0, 0);

describe('buildListRows', () => {
  it('returns no rows for an empty list', () => {
    expect(buildListRows([])).toEqual([]);
  });

  it('orders by activity descending and heads each day group once', () => {
    const rows = buildListRows([
      makeThread({ id: 'old', createdAt: DAY_1 }),
      makeThread({ id: 'new', createdAt: DAY_2 }),
      makeThread({ id: 'old-2', createdAt: DAY_1 - 1000 }),
    ]);

    expect(rows.map((r) => (r.type === 'thread' ? r.thread.id : r.type))).toEqual([
      'day',
      'new',
      'section',
      'day',
      'old',
      'old-2',
    ]);
    // One heading per day, and the section rule only BETWEEN groups.
    expect(rows.filter((r) => r.type === 'day')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'section')).toHaveLength(1);
  });

  it('sorts a thread on top when a reply is newer than its creation', () => {
    const rows = buildListRows([
      makeThread({ id: 'fresh', createdAt: DAY_2 }),
      makeThread({ id: 'bumped', createdAt: DAY_1, lastReplyAt: DAY_2 + 1000 }),
    ]);
    const threadIds = rows.flatMap((r) => (r.type === 'thread' ? [r.thread.id] : []));
    expect(threadIds).toEqual(['bumped', 'fresh']);
  });

  it('opens no day group for an unrenderable timestamp and emits unique keys', () => {
    const rows = buildListRows([
      makeThread({ id: 'a', createdAt: DAY_1 }),
      makeThread({ id: 'broken', createdAt: Number.NaN, lastReplyAt: null }),
      makeThread({ id: 'b', createdAt: DAY_1 - 1000 }),
    ]);

    // Exactly one day heading: the NaN row joins the group it lands in rather
    // than splitting the day and re-emitting its `day-<key>`.
    expect(rows.filter((r) => r.type === 'day')).toHaveLength(1);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    // ...and it sorts last (#883).
    const threadIds = rows.flatMap((r) => (r.type === 'thread' ? [r.thread.id] : []));
    expect(threadIds[threadIds.length - 1]).toBe('broken');
  });
});

// ---------------------------------------------------------------------------
// The sorted-rows cache (#923 "Bounds")
// ---------------------------------------------------------------------------

/**
 * The cache exists because re-sorting a walked list on every `threads` map
 * write costs ~80 ms per rebuild at 10,000 rows on Hermes (69 ms of it the
 * sort alone) against a 50 ms budget. Its one hard requirement is that it is
 * INDISTINGUISHABLE from `buildListRows`, so every case below compares it
 * against that function over the same input.
 */
describe('createThreadListRowsCache', () => {
  /** Deterministic threads spread over `days` days, ids `thread-<n>`. */
  function makeList(count: number, offset = 0, days = 30): Thread[] {
    const out: Thread[] = [];
    for (let i = 0; i < count; i++) {
      const n = offset + i;
      // A Lehmer step, so the input order is neither sorted nor random.
      const jitter = ((n * 48271) % 2147483647) % days;
      out.push(
        makeThread({
          id: `thread-${n}`,
          createdAt: DAY_1 - jitter * 86400000 - n * 1000,
          lastReplyAt: n % 7 === 0 ? DAY_2 + n : null,
        }),
      );
    }
    return out;
  }

  function keys(rows: ReturnType<typeof buildListRows>): string[] {
    return rows.map((r) => r.key);
  }

  it('returns the identical rows array when nothing changed', () => {
    const cache = createThreadListRowsCache();
    const list = makeList(50);
    const first = cache(list);
    // A NEW array holding the same thread objects: what a `threads` map write
    // produces for a list it did not touch.
    const second = cache([...list]);

    expect(second).toBe(first);
    expect(keys(first)).toEqual(keys(buildListRows(list)));
  });

  it('merges an appended page into the kept order, exactly as a full sort would', () => {
    const cache = createThreadListRowsCache();
    const head = makeList(120);
    cache(head);

    const page = makeList(100, 120);
    const merged = cache([...head, ...page]);

    expect(keys(merged)).toEqual(keys(buildListRows([...head, ...page])));
  });

  it('stays correct over several appended pages', () => {
    const cache = createThreadListRowsCache();
    let list = makeList(60);
    cache(list);

    for (let page = 1; page <= 4; page++) {
      list = [...list, ...makeList(40, page * 100)];
      expect(keys(cache(list))).toEqual(keys(buildListRows(list)));
    }
  });

  it('rebuilds when a thread in the kept order changed', () => {
    const cache = createThreadListRowsCache();
    const list = makeList(40);
    cache(list);

    // A reply lands on an old thread: same id, newer activity, so it moves.
    const bumped = [...list];
    bumped[30] = { ...bumped[30], lastReplyAt: DAY_2 + 999999 };

    expect(keys(cache(bumped))).toEqual(keys(buildListRows(bumped)));
  });

  it('rebuilds when rows are removed (a block, or a leave-trim)', () => {
    const cache = createThreadListRowsCache();
    const list = makeList(40);
    cache(list);

    const fewer = list.filter((_t, i) => i % 3 !== 0);
    expect(keys(cache(fewer))).toEqual(keys(buildListRows(fewer)));
  });

  it('empties with the list and recovers afterwards', () => {
    const cache = createThreadListRowsCache();
    const list = makeList(20);
    cache(list);

    expect(cache([])).toEqual([]);
    expect(keys(cache(list))).toEqual(keys(buildListRows(list)));
  });
});
