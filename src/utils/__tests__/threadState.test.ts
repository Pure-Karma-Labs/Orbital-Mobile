/**
 * Tests for getThreadState — the per-thread unread rule (#329), now computing
 * activity through `threadActivityAt` (#883).
 *
 * Both watermarks matter: the per-thread local view time and the per-conversation
 * server `lastReadAt` snapshot. The function takes the max of the two, so a
 * reinstall (no local view times) still reads as caught-up.
 */

import { getThreadState } from '../threadState';
import type { Thread } from '../../types/store';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'Test thread',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: 10_000,
    updatedAt: 10_000,
    syncStatus: 'synced',
    ...overrides,
  } as Thread;
}

describe('getThreadState — per-thread view watermark', () => {
  it('is unread when never viewed and there is no watermark at all', () => {
    expect(getThreadState(makeThread(), {}, null)).toBe('unread');
  });

  it('is read once the thread was viewed after its latest activity', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 12_000 });
    expect(getThreadState(thread, { 'thread-1': 13_000 }, null)).toBe('read');
  });

  it('is unread when the view time is older than the activity', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 12_000 });
    expect(getThreadState(thread, { 'thread-1': 11_000 }, null)).toBe('unread');
  });

  it('ignores another thread\'s view time', () => {
    const thread = makeThread({ id: 'thread-2', createdAt: 10_000 });
    expect(getThreadState(thread, { 'thread-1': 99_000 }, null)).toBe('unread');
  });

  // Activity exactly equal to the watermark is caught-up: the rule is strictly
  // greater-than, so marking read at the instant of the last post clears it.
  it('is read when the activity exactly equals the watermark', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: null });
    expect(getThreadState(thread, { 'thread-1': 10_000 }, null)).toBe('read');
  });
});

describe('getThreadState — conversation lastReadAt snapshot', () => {
  it('falls back to the snapshot when the thread was never viewed locally', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 12_000 });
    expect(getThreadState(thread, {}, 13_000)).toBe('read');
    expect(getThreadState(thread, {}, 11_000)).toBe('unread');
  });

  it('uses the max of the per-thread view time and the snapshot', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 20_000 });
    // Stale snapshot, fresh local view.
    expect(getThreadState(thread, { 'thread-1': 25_000 }, 5_000)).toBe('read');
    // Fresh snapshot, stale local view.
    expect(getThreadState(thread, { 'thread-1': 5_000 }, 25_000)).toBe('read');
    // Neither covers the activity.
    expect(getThreadState(thread, { 'thread-1': 5_000 }, 15_000)).toBe('unread');
  });
});

describe('getThreadState — activity comes from threadActivityAt', () => {
  // The #883 point: a reply lifts an old thread back to unread even though its
  // creation time is far behind both watermarks.
  it('is unread when a reply bumps a thread older than both watermarks', () => {
    const thread = makeThread({ createdAt: 1_000, lastReplyAt: 30_000 });
    expect(getThreadState(thread, { 'thread-1': 20_000 }, 20_000)).toBe('unread');
  });

  it('uses createdAt alone when there are no replies', () => {
    const thread = makeThread({ createdAt: 30_000, lastReplyAt: null });
    expect(getThreadState(thread, {}, 25_000)).toBe('unread');
    expect(getThreadState(thread, {}, 35_000)).toBe('read');
  });

  // Deliberate: NaN activity means `NaN > watermark` is false, so an
  // unrenderable row reports 'read' rather than showing an unread dot that no
  // amount of reading can clear.
  it('is read when no timestamp is valid (NaN activity)', () => {
    expect(getThreadState(makeThread({ createdAt: NaN, lastReplyAt: null }), {}, null)).toBe(
      'read',
    );
    expect(getThreadState(makeThread({ createdAt: NaN, lastReplyAt: NaN }), {}, null)).toBe(
      'read',
    );
    expect(getThreadState(makeThread({ createdAt: 0, lastReplyAt: 0 }), {}, null)).toBe('read');
  });

  it('still reads the valid side when only one timestamp is corrupt', () => {
    // A NaN createdAt no longer poisons the comparison: the reply still counts.
    expect(
      getThreadState(makeThread({ createdAt: NaN, lastReplyAt: 30_000 }), {}, 20_000),
    ).toBe('unread');
    // An Infinity lastReplyAt is dropped instead of winning forever.
    expect(
      getThreadState(makeThread({ createdAt: 10_000, lastReplyAt: Infinity }), {}, 20_000),
    ).toBe('read');
  });
});
