/**
 * `buildListRows` — the day-grouped row model both list screens render (#923).
 *
 * The function was lifted out of ThreadsScreen/ChatDetailScreen unchanged, so
 * these cases pin the behaviour the two screens' own suites already assert
 * through the rendered tree: order, one heading per day, a section rule only
 * BETWEEN groups, and an unrenderable timestamp that opens no group.
 */

import { buildListRows } from '../threadListRows';
import { makeThread } from '../../testUtils/makeThread';

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
