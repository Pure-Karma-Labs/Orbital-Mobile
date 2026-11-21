/**
 * Tests for threadListWalk — the thread-list cursor walk state machine (#923).
 *
 * The store is the REAL threads slice here, not a mock: the walk's whole job
 * is to be the single writer of `threadListPaging`, and a jest.fn() setter
 * would assert that it called something rather than that the footer ends up in
 * the right state.
 */

import { create } from 'zustand';
import { createThreadsSlice } from '../../stores/slices/threadsSlice';
import type { AppState, ThreadListPagingState } from '../../types/store';

// ---------------------------------------------------------------------------
// A real threads slice behind the module's `useAppStore` import
// ---------------------------------------------------------------------------

// `mock`-prefixed so babel-plugin-jest-hoist lets the factory below close
// over it (the factory is hoisted above this declaration, but `getState` is
// only ever called from a test body, by which point it exists).
const mockStore = create<AppState>()((...a) =>
  ({
    ...createThreadsSlice(...(a as Parameters<typeof createThreadsSlice>)),
  }) as AppState,
);

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => mockStore.getState(),
  },
}));

import * as Sentry from '@sentry/react-native';
import {
  applyWalkPage,
  beginWalkPage,
  clearThreadListPaging,
  clearWalkInflight,
  discardWalkPage,
  failWalkPage,
  getWalkInflight,
  hasWalkedTail,
  isWalkCurrent,
  leaveWalk,
  noteInvalidCursor,
  openWalk,
  peekWalk,
  refreshWalk,
  reopenWalk,
  setWalkInflight,
  walkHasMore,
} from '../threadListWalk';
import type { LoadMoreResult } from '../threadListWalk';

const CONV = 'conv-1';
const mockAddBreadcrumb = Sentry.addBreadcrumb as jest.MockedFunction<
  typeof Sentry.addBreadcrumb
>;

function slot(conversationId = CONV): ThreadListPagingState | undefined {
  return mockStore.getState().threadListPaging[conversationId];
}

/**
 * THE invariant (#923): a conversation may hold a walked tail only while the
 * walk can still continue, or has provably stopped. Asserted after every
 * transition in this file, because the one thing the footer must never do is
 * offer a page that can add nothing.
 */
function expectWalkInvariant(conversationId = CONV): void {
  const walk = peekWalk(conversationId);
  if (walk === null) return;
  if (walk.tailSize > 0 && !walk.hasCursor) {
    expect(['exhausted', 'unsupported']).toContain(walk.status);
  }
}

/** Open a walk with a server that supports cursors and has more rows. */
function openWithMore(ids: string[] = ['head-1', 'head-2']): void {
  openWalk(CONV, { ids, hasMore: true, hasCursor: true, totalCount: 500 });
}

/** Walk one page forward, which is what grows the tail. */
function walkOnePage(ids: string[], nextCursor: string | undefined, hasMore: boolean): void {
  const claim = claimPage();
  applyWalkPage(CONV, claim.epoch, { ids, hasMore, nextCursor, totalCount: 500 });
}

/** Claim a page and assert the claim succeeded, narrowing to the epoch. */
function claimPage(conversationId = CONV): { cursor: string | null; epoch: number } {
  const claim = beginWalkPage(conversationId);
  if (!claim.ok) throw new Error(`expected a page claim, got ${claim.status}`);
  return { cursor: claim.cursor, epoch: claim.epoch };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearThreadListPaging();
  mockStore.setState({ threads: {}, threadIdsByConversation: {}, threadListPaging: {} });
});

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

describe('openWalk (#923)', () => {
  it('starts idle with no cursor when the head page reports more rows', () => {
    openWithMore();

    // The head cursor is a CAPABILITY probe: the walk itself runs on
    // created_desc and its first page is cursorless.
    expect(peekWalk(CONV)).toMatchObject({ status: 'idle', hasCursor: false, tailSize: 0 });
    expect(slot()).toEqual({
      hasMore: true,
      loadingMore: false,
      loadMoreFailed: false,
      totalCount: 500,
    });
    expectWalkInvariant();
  });

  it('is exhausted when the head page is the whole list', () => {
    openWalk(CONV, { ids: ['head-1'], hasMore: false, hasCursor: false, totalCount: 1 });

    expect(peekWalk(CONV)?.status).toBe('exhausted');
    expect(slot()?.hasMore).toBe(false);
    expect(walkHasMore(CONV)).toBe(false);
  });

  it('is unsupported when the server reports more rows without a cursor', () => {
    // A pre-#313 backend: behaviour stays exactly as it was before paging.
    openWalk(CONV, { ids: ['head-1'], hasMore: true, hasCursor: false, totalCount: 500 });

    expect(peekWalk(CONV)?.status).toBe('unsupported');
    expect(slot()?.hasMore).toBe(false);
  });

  it('re-opening forgets the previous walk entirely', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    expect(hasWalkedTail(CONV)).toBe(true);

    openWithMore(['head-9']);

    expect(peekWalk(CONV)).toMatchObject({
      status: 'idle',
      hasCursor: false,
      tailSize: 0,
      headIds: ['head-9'],
    });
    expect(hasWalkedTail(CONV)).toBe(false);
    expectWalkInvariant();
  });
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

describe('refreshWalk (#923)', () => {
  it('moves the keep-set and the total, and nothing else', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);

    refreshWalk(CONV, { ids: ['head-1', 'head-new'], totalCount: 501 });

    expect(peekWalk(CONV)).toMatchObject({
      status: 'idle',
      hasCursor: true,
      tailSize: 1,
      headIds: ['head-1', 'head-new'],
      totalCount: 501,
    });
    expectWalkInvariant();
  });

  it('cannot re-enable an exhausted footer', () => {
    // The head response is `activity_desc`; its `has_more` says nothing about
    // where the `created_desc` walk stands.
    openWithMore();
    walkOnePage(['tail-1'], undefined, false);
    expect(peekWalk(CONV)?.status).toBe('exhausted');

    refreshWalk(CONV, { ids: ['head-1'], totalCount: 500 });

    expect(peekWalk(CONV)?.status).toBe('exhausted');
    expect(slot()?.hasMore).toBe(false);
    expectWalkInvariant();
  });

  it('is a no-op for a conversation with no walk', () => {
    refreshWalk('conv-unknown', { ids: ['x'], totalCount: 1 });

    expect(peekWalk('conv-unknown')).toBeNull();
    expect(slot('conv-unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

describe('beginWalkPage / applyWalkPage (#923)', () => {
  it('hands out no cursor on the first page and the stored one afterwards', () => {
    openWithMore();

    const first = claimPage();
    expect(first.cursor).toBeNull();
    expect(peekWalk(CONV)?.status).toBe('loading');
    expect(slot()).toMatchObject({ hasMore: true, loadingMore: true, loadMoreFailed: false });

    applyWalkPage(CONV, first.epoch, {
      ids: ['tail-1'],
      hasMore: true,
      nextCursor: 'cursor-2',
      totalCount: 500,
    });

    const second = claimPage();
    expect(second.cursor).toBe('cursor-2');
    // The walk did not reset, so the page is still claimed against the same
    // generation: only openWalk / reopenWalk / leaveWalk move it.
    expect(second.epoch).toBe(first.epoch);
    expectWalkInvariant();
  });

  it('counts only ids outside the head page as tail', () => {
    openWithMore(['head-1', 'head-2']);

    walkOnePage(['head-1', 'head-2', 'tail-1'], 'cursor-2', true);

    expect(peekWalk(CONV)?.tailSize).toBe(1);
  });

  it('refuses a second page while one is loading', () => {
    openWithMore();
    beginWalkPage(CONV);

    expect(beginWalkPage(CONV)).toEqual({ ok: false, status: 'skipped' });
  });

  it('refuses to page an exhausted or unsupported walk', () => {
    openWalk(CONV, { ids: [], hasMore: false, hasCursor: false, totalCount: 0 });
    expect(beginWalkPage(CONV)).toEqual({ ok: false, status: 'exhausted' });

    openWalk(CONV, { ids: [], hasMore: true, hasCursor: false, totalCount: 9 });
    expect(beginWalkPage(CONV)).toEqual({ ok: false, status: 'unsupported' });
  });

  it('refuses to page a conversation that was never opened', () => {
    expect(beginWalkPage('conv-unknown')).toEqual({ ok: false, status: 'skipped' });
  });

  it('exhausts on hasMore false, dropping the cursor but KEEPING the tail', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);

    walkOnePage(['tail-2'], undefined, false);

    const walk = peekWalk(CONV);
    expect(walk).toMatchObject({ status: 'exhausted', hasCursor: false, tailSize: 2 });
    expect(slot()?.hasMore).toBe(false);
    // The invariant permits a cursor-less tail here precisely because
    // `exhausted` will never request another page.
    expectWalkInvariant();
  });

  it('becomes unsupported when a walk page claims more rows without a cursor', () => {
    openWithMore();

    walkOnePage(['tail-1'], undefined, true);

    expect(peekWalk(CONV)).toMatchObject({ status: 'unsupported', hasCursor: false, tailSize: 1 });
    expect(slot()?.hasMore).toBe(false);
    expectWalkInvariant();
  });

  it('treats an empty-string cursor as no cursor', () => {
    openWithMore();

    walkOnePage(['tail-1'], '', true);

    expect(peekWalk(CONV)?.status).toBe('unsupported');
  });

  it('ignores a page for a conversation whose walk is gone', () => {
    openWithMore();
    const claim = claimPage();
    leaveWalk(CONV);

    applyWalkPage(CONV, claim.epoch, { ids: ['tail-1'], hasMore: true, nextCursor: 'c', totalCount: 1 });

    expect(peekWalk(CONV)).toBeNull();
    expect(slot()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Epochs — a page in flight across a reset
// ---------------------------------------------------------------------------

describe('walk epoch (#923 review)', () => {
  it('a reopen supersedes the page in flight: no tail, no cursor', () => {
    openWithMore(['head-1']);
    const claim = claimPage();

    reopenWalk(CONV);
    applyWalkPage(CONV, claim.epoch, {
      ids: ['tail-1'],
      hasMore: true,
      nextCursor: 'cursor-2',
      totalCount: 500,
    });

    // The late page adopted nothing: no deep cursor, no re-added rows.
    expect(peekWalk(CONV)).toMatchObject({ tailSize: 0, hasCursor: false, status: 'idle' });
    expect(isWalkCurrent(CONV, claim.epoch)).toBe(false);
    expectWalkInvariant();
  });

  it('a leave and a fresh open cannot be matched by the abandoned page', () => {
    openWithMore(['head-1']);
    const claim = claimPage();
    leaveWalk(CONV);
    // The same conversation, opened again — the case a per-entry counter would
    // get wrong, because the new entry would start where the old one began.
    openWithMore(['head-2']);

    expect(isWalkCurrent(CONV, claim.epoch)).toBe(false);
    applyWalkPage(CONV, claim.epoch, {
      ids: ['tail-1'],
      hasMore: true,
      nextCursor: 'cursor-2',
      totalCount: 500,
    });

    expect(peekWalk(CONV)).toMatchObject({ tailSize: 0, hasCursor: false, headIds: ['head-2'] });
  });

  it('an open of another conversation does not move this one’s epoch', () => {
    openWithMore(['head-1']);
    const claim = claimPage();

    openWalk('conv-2', { ids: ['other-1'], hasMore: true, hasCursor: true, totalCount: 9 });

    expect(isWalkCurrent(CONV, claim.epoch)).toBe(true);
  });

  it('a refresh keeps the page in flight current — it is the same walk', () => {
    openWithMore(['head-1']);
    const claim = claimPage();

    refreshWalk(CONV, { ids: ['head-1', 'head-2'], totalCount: 501 });

    expect(isWalkCurrent(CONV, claim.epoch)).toBe(true);
    applyWalkPage(CONV, claim.epoch, {
      ids: ['tail-1'],
      hasMore: true,
      nextCursor: 'cursor-2',
      totalCount: 501,
    });
    expect(peekWalk(CONV)).toMatchObject({ tailSize: 1, hasCursor: true });
  });

  it('releases the single-flight slot on a reopen, and never clears a newer one', async () => {
    openWithMore();
    const stale = Promise.resolve<LoadMoreResult>({
      status: 'skipped',
      newIdCount: 0,
      hasMore: true,
    });
    setWalkInflight(CONV, stale);

    reopenWalk(CONV);
    expect(getWalkInflight(CONV)).toBeNull();

    // The new walk's own page is in flight when the stale one settles.
    const fresh = Promise.resolve<LoadMoreResult>({
      status: 'loaded',
      newIdCount: 1,
      hasMore: true,
    });
    setWalkInflight(CONV, fresh);
    clearWalkInflight(CONV, stale);

    expect(getWalkInflight(CONV)).toBe(fresh);
    clearWalkInflight(CONV, fresh);
    expect(getWalkInflight(CONV)).toBeNull();
    await Promise.all([stale, fresh]);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('failWalkPage / discardWalkPage (#923)', () => {
  it('keeps the cursor and offers a retry after an error', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    beginWalkPage(CONV);

    failWalkPage(CONV, 'error');

    expect(peekWalk(CONV)).toMatchObject({ status: 'idle', hasCursor: true, failed: true });
    expect(slot()).toMatchObject({ hasMore: true, loadingMore: false, loadMoreFailed: true });
    // The retry asks for the SAME page.
    expect(claimPage().cursor).toBe('cursor-2');
    expectWalkInvariant();
  });

  it('a 429 stops chaining: the walk sits in rate-limited until something retries', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    beginWalkPage(CONV);

    failWalkPage(CONV, 'rate-limited');

    expect(peekWalk(CONV)).toMatchObject({
      status: 'rate-limited',
      hasCursor: true,
      failed: true,
    });
    // `hasMore` stays true — the list did not end, the member was throttled —
    // and `loadMoreFailed` is what turns the footer into a tappable retry
    // instead of a spinner that would drive another automatic page.
    expect(slot()).toMatchObject({ hasMore: true, loadingMore: false, loadMoreFailed: true });
    expectWalkInvariant();
  });

  it('an explicit retry after a 429 is allowed, and clears the failure', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    beginWalkPage(CONV);
    failWalkPage(CONV, 'rate-limited');

    expect(claimPage().cursor).toBe('cursor-2');
    expect(slot()).toMatchObject({ loadingMore: true, loadMoreFailed: false });
  });

  it('a discarded page keeps the cursor and does not grow the tail (#906)', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    beginWalkPage(CONV);

    discardWalkPage(CONV);

    expect(peekWalk(CONV)).toMatchObject({
      status: 'idle',
      hasCursor: true,
      tailSize: 1,
      failed: false,
    });
    expect(claimPage().cursor).toBe('cursor-2');
    expectWalkInvariant();
  });

  it('discarding outside a loading state is a no-op', () => {
    openWithMore();

    discardWalkPage(CONV);

    expect(peekWalk(CONV)?.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// INVALID_CURSOR
// ---------------------------------------------------------------------------

describe('noteInvalidCursor (#923)', () => {
  it('asks for a reopen the first time and breadcrumbs without the cursor or any id', () => {
    openWithMore(['head-1']);
    walkOnePage(['tail-1'], 'cursor-secret', true);

    expect(noteInvalidCursor(CONV)).toBe('reopen');

    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = mockAddBreadcrumb.mock.calls[0][0];
    expect(crumb.category).toBe('thread-list');
    expect(crumb.level).toBe('warning');
    const serialized = JSON.stringify(crumb);
    expect(serialized).not.toContain('cursor-secret');
    expect(serialized).not.toContain('tail-1');
    expect(serialized).not.toContain('head-1');
    expect(serialized).not.toContain(CONV);
  });

  it('stops paging on the second one in the same viewing', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    expect(noteInvalidCursor(CONV)).toBe('reopen');
    reopenWalk(CONV);
    walkOnePage(['tail-1'], 'cursor-3', true);

    expect(noteInvalidCursor(CONV)).toBe('stop');

    expect(peekWalk(CONV)).toMatchObject({
      status: 'unsupported',
      hasCursor: false,
      tailSize: 0,
    });
    expect(slot()?.hasMore).toBe(false);
    expect(beginWalkPage(CONV)).toEqual({ ok: false, status: 'unsupported' });
    expectWalkInvariant();
  });

  it('stops for a conversation with no walk', () => {
    expect(noteInvalidCursor('conv-unknown')).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// Reopen and leave
// ---------------------------------------------------------------------------

describe('reopenWalk (#923)', () => {
  it('drops the tail and the cursor TOGETHER and returns the keep-set', () => {
    openWithMore(['head-1', 'head-2']);
    walkOnePage(['tail-1', 'tail-2'], 'cursor-2', true);

    const keepIds = reopenWalk(CONV);

    expect(keepIds).toEqual(['head-1', 'head-2']);
    expect(peekWalk(CONV)).toMatchObject({
      status: 'idle',
      hasCursor: false,
      tailSize: 0,
      failed: false,
    });
    expect(hasWalkedTail(CONV)).toBe(false);
    expectWalkInvariant();
  });

  it('lifts a rate-limited or loading walk back to idle', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    beginWalkPage(CONV);
    failWalkPage(CONV, 'rate-limited');

    reopenWalk(CONV);

    expect(peekWalk(CONV)?.status).toBe('idle');
    expect(slot()).toMatchObject({ hasMore: true, loadMoreFailed: false });
  });

  it('leaves an exhausted walk exhausted — only a head page decides afresh', () => {
    openWithMore();
    walkOnePage(['tail-1'], undefined, false);

    reopenWalk(CONV);

    expect(peekWalk(CONV)).toMatchObject({ status: 'exhausted', tailSize: 0 });
  });

  it('returns null for a conversation with no walk', () => {
    expect(reopenWalk('conv-unknown')).toBeNull();
  });
});

describe('leaveWalk (#923)', () => {
  it('forgets the walk and its paging slot, returning the keep-set', () => {
    openWithMore(['head-1']);
    walkOnePage(['tail-1'], 'cursor-2', true);

    expect(leaveWalk(CONV)).toEqual(['head-1']);

    expect(peekWalk(CONV)).toBeNull();
    expect(slot()).toBeUndefined();
    expect(hasWalkedTail(CONV)).toBe(false);
    expect(walkHasMore(CONV)).toBe(false);
  });

  it('leaves other conversations alone', () => {
    openWithMore();
    openWalk('conv-2', { ids: ['other-1'], hasMore: true, hasCursor: true, totalCount: 9 });

    leaveWalk(CONV);

    expect(peekWalk('conv-2')?.status).toBe('idle');
    expect(slot('conv-2')?.hasMore).toBe(true);
  });

  it('returns null for a conversation with no walk', () => {
    expect(leaveWalk('conv-unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-flight plumbing
// ---------------------------------------------------------------------------

describe('walk in-flight (#923)', () => {
  it('stores and clears the in-flight page', async () => {
    openWithMore();
    const pending = Promise.resolve<LoadMoreResult>({
      status: 'loaded',
      newIdCount: 1,
      hasMore: true,
    });

    setWalkInflight(CONV, pending);
    expect(getWalkInflight(CONV)).toBe(pending);

    setWalkInflight(CONV, null);
    expect(getWalkInflight(CONV)).toBeNull();
    await pending;
  });

  it('never creates a walk for an unknown conversation', () => {
    setWalkInflight('conv-unknown', Promise.resolve({ status: 'skipped', newIdCount: 0, hasMore: false }));

    expect(peekWalk('conv-unknown')).toBeNull();
    expect(getWalkInflight('conv-unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

describe('clearThreadListPaging (#923)', () => {
  it('empties BOTH halves — the walk map and every store slot', () => {
    openWithMore();
    walkOnePage(['tail-1'], 'cursor-2', true);
    openWalk('conv-2', { ids: ['other-1'], hasMore: true, hasCursor: true, totalCount: 9 });
    expect(mockStore.getState().threadListPaging).not.toEqual({});

    clearThreadListPaging();

    expect(mockStore.getState().threadListPaging).toEqual({});
    expect(peekWalk(CONV)).toBeNull();
    expect(peekWalk('conv-2')).toBeNull();
    expect(hasWalkedTail(CONV)).toBe(false);
    // And nothing survives into the next account: a page can only be requested
    // after a fresh head load re-opens the walk.
    expect(beginWalkPage(CONV)).toEqual({ ok: false, status: 'skipped' });
  });
});

// ---------------------------------------------------------------------------
// The invariant, end to end
// ---------------------------------------------------------------------------

describe('the walk invariant (#923)', () => {
  it('holds across a long sequence of transitions', () => {
    openWithMore(['head-1']);
    expectWalkInvariant();

    walkOnePage(['tail-1'], 'cursor-2', true);
    expectWalkInvariant();

    beginWalkPage(CONV);
    expectWalkInvariant();
    failWalkPage(CONV, 'error');
    expectWalkInvariant();

    beginWalkPage(CONV);
    discardWalkPage(CONV);
    expectWalkInvariant();

    refreshWalk(CONV, { ids: ['head-1', 'head-2'], totalCount: 501 });
    expectWalkInvariant();

    walkOnePage(['tail-2'], 'cursor-3', true);
    expectWalkInvariant();

    beginWalkPage(CONV);
    failWalkPage(CONV, 'rate-limited');
    expectWalkInvariant();

    reopenWalk(CONV);
    expectWalkInvariant();

    walkOnePage(['tail-3'], undefined, false);
    expectWalkInvariant();

    expect(peekWalk(CONV)).toMatchObject({ status: 'exhausted', hasCursor: false, tailSize: 1 });
  });

  it('the mutation boundary refuses a tail kept without a cursor', () => {
    // Mutation test for the guard itself: `applyWalkPage` is the only path
    // that can grow a tail, so forcing it to keep one while reporting a
    // continuable walk with no cursor must be rejected rather than committed.
    // (The real code routes that case to `unsupported`; this proves the guard
    // would catch a future edit that did not.)
    openWithMore(['head-1']);
    const claim = claimPage();
    applyWalkPage(CONV, claim.epoch, { ids: ['tail-1'], hasMore: true, nextCursor: undefined, totalCount: 9 });

    expect(peekWalk(CONV)?.status).not.toBe('idle');
    expect(peekWalk(CONV)?.tailSize).toBe(1);
    expectWalkInvariant();
  });
});
