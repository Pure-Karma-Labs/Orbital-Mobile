/**
 * `useThreadListPaging` — the UI half of the thread-list cursor walk (#923).
 *
 * The service layer is mocked at its own seam (`loadMoreThreadsForGroup`,
 * `leaveThreadList`): every behaviour under test here is about what the hook
 * does with a RESULT, not how the result was produced. The store selector is
 * mocked as a mutable slot, which is what `threadListWalk` writes in
 * production, so a test can make a page "land" by setting the slot the way the
 * walk would.
 *
 * The footer is asserted as an ELEMENT (`footer.props`), never rendered: the
 * real one pulls in a theme and an animated spinner, and nothing here is about
 * either (see the leaked-animation-timer rule in the RN suite notes).
 *
 * Uses the project's minimal renderHook helper — @testing-library/react-native
 * is not installed. No fake timers.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  useThreadListPaging,
  MAX_FOLLOW_UP_PAGES,
  type ThreadListPaging,
  type UseThreadListPagingOptions,
} from '../useThreadListPaging';
import { ThreadListFooter } from '../../components/ThreadListFooter';
import type { LoadMoreResult } from '../../services/threadListWalk';
import type { ThreadListPagingState } from '../../types/store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** The slot `threadListWalk` writes; mutated by tests to stand in for a walk. */
let mockPaging: ThreadListPagingState = {
  hasMore: true,
  loadingMore: false,
  loadMoreFailed: false,
  totalCount: 0,
  reopenCount: 0,
};

jest.mock('../../stores', () => ({
  useThreadListPagingState: (): ThreadListPagingState => mockPaging,
}));

jest.mock('../../services/threadService', () => ({
  loadMoreThreadsForGroup: jest.fn(),
  leaveThreadList: jest.fn(),
}));

import { loadMoreThreadsForGroup, leaveThreadList } from '../../services/threadService';

const mockLoadMore = loadMoreThreadsForGroup as jest.Mock;
const mockLeave = leaveThreadList as jest.Mock;

function result(over: Partial<LoadMoreResult> = {}): LoadMoreResult {
  return { status: 'loaded', newIdCount: 10, hasMore: true, ...over };
}

/** Mimic what the walk writes into the store slot when a page settles. */
function setSlot(over: Partial<ThreadListPagingState>): void {
  mockPaging = { ...mockPaging, ...over };
}

// ---------------------------------------------------------------------------
// Minimal renderHook helper
// ---------------------------------------------------------------------------

interface Harness {
  result: { current: ThreadListPaging };
  rerender: (next: Partial<UseThreadListPagingOptions>) => void;
  unmount: () => void;
}

const BASE: UseThreadListPagingOptions = {
  conversationId: 'group-1',
  renderedCount: 40,
};

function renderPaging(initial: Partial<UseThreadListPagingOptions> = {}): Harness {
  const current = { current: undefined as unknown as ThreadListPaging };
  let props: UseThreadListPagingOptions = { ...BASE, ...initial };

  function Probe(p: { options: UseThreadListPagingOptions }): null {
    current.current = useThreadListPaging(p.options);
    return null;
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(Probe, { options: props }));
  });

  return {
    result: current,
    rerender: (next) => {
      props = { ...props, ...next };
      act(() => {
        renderer.update(React.createElement(Probe, { options: props }));
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Drive one end-reach and let every chained page settle. */
async function endReach(h: Harness): Promise<void> {
  await act(async () => {
    h.result.current.onEndReached();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPaging = {
    hasMore: true,
    loadingMore: false,
    loadMoreFailed: false,
    totalCount: 0,
    reopenCount: 0,
  };
  mockLoadMore.mockResolvedValue(result());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useThreadListPaging — one page per end-reach', () => {
  it('requests a page and stops once the page added rows', async () => {
    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(mockLoadMore).toHaveBeenCalledWith('group-1');
    expect(h.result.current.stalled).toBe(false);
    expect(h.result.current.footer).toBeNull();
  });

  it('ignores a second end-reach while a page is in flight (the ref guard)', async () => {
    let release: (r: LoadMoreResult) => void = () => {};
    mockLoadMore.mockImplementation(
      () =>
        new Promise<LoadMoreResult>((resolve) => {
          release = resolve;
        }),
    );

    const h = renderPaging();
    act(() => {
      h.result.current.onEndReached();
      h.result.current.onEndReached();
      h.result.current.onEndReached();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    // ...and the footer is a spinner while it is in flight.
    expect(h.result.current.loading).toBe(true);
    expect(h.result.current.footer?.props).toMatchObject({ loading: true, stalled: false });

    await act(async () => {
      release(result());
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the walk has no more pages', async () => {
    setSlot({ hasMore: false });
    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(h.result.current.footer).toBeNull();
  });

  it('does nothing while the screen is searching', async () => {
    const h = renderPaging({ disabled: true });
    await endReach(h);

    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(h.result.current.footer).toBeNull();
  });
});

describe('useThreadListPaging — the follow-up loop', () => {
  it('keeps paging while pages add no ids, then stops when one does', async () => {
    mockLoadMore
      .mockResolvedValueOnce(result({ newIdCount: 0 }))
      .mockResolvedValueOnce(result({ newIdCount: 0 }))
      .mockResolvedValueOnce(result({ newIdCount: 7 }));

    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(3);
    expect(h.result.current.stalled).toBe(false);
  });

  it('caps the loop and offers a tap when nothing ever grows', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 0 }));

    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES);
    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.footer?.type).toBe(ThreadListFooter);
    expect(h.result.current.footer?.props).toMatchObject({ loading: false, stalled: true });
    // A capped walk still has somewhere to go: an error must never end it.
    expect(h.result.current.hasMore).toBe(true);
  });

  it('a further end-reach does not re-arm a capped walk; a tap does', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 0 }));
    const h = renderPaging();
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES);

    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES);

    mockLoadMore.mockResolvedValue(result({ newIdCount: 5 }));
    await act(async () => {
      h.result.current.retry();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES + 1);
    expect(h.result.current.stalled).toBe(false);
  });

  it('with a filter active, new ids that render nothing keep the loop going', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 25 }));

    // renderedCount never moves: every author on these pages is blocked.
    const h = renderPaging({ filtersActive: true, renderedCount: 3 });
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES);
    expect(h.result.current.stalled).toBe(true);
  });

  it('with no filter active, new ids are taken as growth after one page', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 25 }));
    const h = renderPaging({ filtersActive: false, renderedCount: 3 });
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('useThreadListPaging — failures never end the walk', () => {
  it('a rejected page offers a retry and keeps hasMore true', async () => {
    mockLoadMore.mockRejectedValueOnce(new Error('network'));
    setSlot({ loadMoreFailed: false });

    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(h.result.current.hasMore).toBe(true);
    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.footer?.props).toMatchObject({ loading: false, stalled: true });

    mockLoadMore.mockResolvedValue(result({ newIdCount: 12 }));
    await act(async () => {
      h.result.current.footer?.props.onRetry();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(2);
    expect(h.result.current.stalled).toBe(false);
  });

  it('a 429 chains nothing and offers a retry', async () => {
    mockLoadMore.mockResolvedValue(result({ status: 'rate-limited', newIdCount: 0 }));

    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.hasMore).toBe(true);
  });

  it("the store's own loadMoreFailed flag alone offers the tap", () => {
    setSlot({ loadMoreFailed: true });
    const h = renderPaging();

    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.footer?.props).toMatchObject({ stalled: true });
  });

  it('a skipped page stops the loop rather than spinning', async () => {
    mockLoadMore.mockResolvedValue(result({ status: 'skipped', newIdCount: 0 }));
    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(h.result.current.stalled).toBe(true);
  });
});

describe('useThreadListPaging — terminal walk states', () => {
  it.each(['exhausted', 'unsupported'] as const)(
    'stops without a retry row on %s',
    async (status) => {
      mockLoadMore.mockImplementation(async () => {
        setSlot({ hasMore: false });
        return result({ status, newIdCount: 0, hasMore: false });
      });

      const h = renderPaging();
      await endReach(h);

      expect(mockLoadMore).toHaveBeenCalledTimes(1);
      h.rerender({});
      expect(h.result.current.hasMore).toBe(false);
      expect(h.result.current.stalled).toBe(false);
      expect(h.result.current.footer).toBeNull();
    },
  );

  it('stops the pass on a reopen, leaving the list at its head', async () => {
    mockLoadMore.mockResolvedValue(result({ status: 'reopened', newIdCount: 0 }));
    const h = renderPaging();
    await endReach(h);

    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(h.result.current.stalled).toBe(false);
  });
});

describe('useThreadListPaging — the first-scroll gate', () => {
  it('does not walk a short list until the member actually drags it', async () => {
    const h = renderPaging({ requireFirstScroll: true, renderedCount: 4 });
    await endReach(h);
    expect(mockLoadMore).not.toHaveBeenCalled();

    act(() => {
      h.result.current.onScrollBeginDrag();
    });
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('a tap is itself the gesture: retry walks without a drag', async () => {
    const h = renderPaging({ requireFirstScroll: true, renderedCount: 4 });
    await act(async () => {
      h.result.current.retry();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('closes the gate again when the conversation changes', async () => {
    const h = renderPaging({ requireFirstScroll: true, renderedCount: 4 });
    act(() => {
      h.result.current.onScrollBeginDrag();
    });
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);

    h.rerender({ conversationId: 'group-2' });
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('useThreadListPaging — an empty list that has more', () => {
  it('walks on its own when nothing renders and the gate is open', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 30 }));
    await act(async () => {
      renderPaging({ renderedCount: 0 });
    });

    expect(mockLoadMore).toHaveBeenCalledWith('group-1');
  });

  it('offers a tap, and walks nothing, when the gate is closed (a DM)', async () => {
    let h!: Harness;
    await act(async () => {
      h = renderPaging({ renderedCount: 0, requireFirstScroll: true });
    });

    // Nothing walks on its own — but an unscrollable list can never open the
    // gate, so the member is left the one gesture that can: the row.
    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.footer?.props).toMatchObject({ loading: false, stalled: true });

    mockLoadMore.mockResolvedValue(result({ newIdCount: 20 }));
    await act(async () => {
      h.result.current.footer?.props.onRetry();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('a gated end-reach on a NON-empty list stays silent (no row, no walk)', async () => {
    // The content-size `onEndReached` the gate exists to swallow: arming the
    // retry row here would put a "Load more" under every short DM.
    const h = renderPaging({ renderedCount: 4, requireFirstScroll: true });
    await endReach(h);

    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(h.result.current.stalled).toBe(false);
    expect(h.result.current.footer).toBeNull();
  });

  it('does not walk an empty list that is searching', async () => {
    await act(async () => {
      renderPaging({ renderedCount: 0, disabled: true });
    });

    expect(mockLoadMore).not.toHaveBeenCalled();
  });

  it('does not walk an empty list with no walk behind it', async () => {
    setSlot({ hasMore: false });
    await act(async () => {
      renderPaging({ renderedCount: 0 });
    });

    expect(mockLoadMore).not.toHaveBeenCalled();
  });
});

describe('useThreadListPaging — a reopen that drops the walked tail', () => {
  /** Stand in for a reopen landing: the walk bumps the slot's counter. */
  function reopen(h: Harness, count: number): void {
    setSlot({ reopenCount: count });
    h.rerender({});
  }

  it('tells the screen to scroll, once per reopen', () => {
    const onTailDropped = jest.fn();
    const h = renderPaging({ onTailDropped });
    // A first open is not a reopen.
    expect(onTailDropped).not.toHaveBeenCalled();

    reopen(h, 1);
    expect(onTailDropped).toHaveBeenCalledTimes(1);

    // A render that changes nothing else must not scroll again.
    h.rerender({ renderedCount: 41 });
    expect(onTailDropped).toHaveBeenCalledTimes(1);

    reopen(h, 2);
    expect(onTailDropped).toHaveBeenCalledTimes(2);
  });

  it('does not scroll on a mount that already has reopens behind it', () => {
    setSlot({ reopenCount: 4 });
    const onTailDropped = jest.fn();
    const h = renderPaging({ onTailDropped });
    h.rerender({});

    expect(onTailDropped).not.toHaveBeenCalled();
  });

  it('does not scroll when the conversation changes under a higher count', () => {
    const onTailDropped = jest.fn();
    const h = renderPaging({ onTailDropped });
    reopen(h, 1);
    expect(onTailDropped).toHaveBeenCalledTimes(1);

    // The new conversation's slot is a different counter entirely: 5 after 1
    // is not an increase anyone scrolled through, and 0 after 1 is not a
    // decrease worth noticing either.
    setSlot({ reopenCount: 5 });
    h.rerender({ conversationId: 'group-2' });
    expect(onTailDropped).toHaveBeenCalledTimes(1);

    // ...and the new conversation's own next reopen still counts.
    reopen(h, 6);
    expect(onTailDropped).toHaveBeenCalledTimes(2);
  });

  it('re-arms the DM first-scroll gate, so the list does not walk straight back down', async () => {
    const h = renderPaging({ requireFirstScroll: true, renderedCount: 4 });
    act(() => {
      h.result.current.onScrollBeginDrag();
    });
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);

    reopen(h, 1);
    // The content-size `onEndReached` that follows the trim must not walk.
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);

    // A fresh drag is still the way through.
    act(() => {
      h.result.current.onScrollBeginDrag();
    });
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(2);
  });

  it('clears a cap earned by the tail that was just dropped', async () => {
    mockLoadMore.mockResolvedValue(result({ newIdCount: 0 }));
    const h = renderPaging();
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES);
    expect(h.result.current.stalled).toBe(true);

    reopen(h, 1);
    // The cap belonged to a cursor the reopen threw away: no "Load more" row
    // over a fresh head page, and a scroll walks again without a tap.
    expect(h.result.current.stalled).toBe(false);
    expect(h.result.current.footer).toBeNull();

    mockLoadMore.mockResolvedValue(result({ newIdCount: 9 }));
    await endReach(h);
    expect(mockLoadMore).toHaveBeenCalledTimes(MAX_FOLLOW_UP_PAGES + 1);
  });

  it('keeps the tap row when the reopened list renders nothing', async () => {
    let h!: Harness;
    await act(async () => {
      h = renderPaging({ renderedCount: 0, requireFirstScroll: true });
    });
    expect(h.result.current.stalled).toBe(true);

    reopen(h, 1);
    // Nothing renders, so there is no list to scroll and `onEndReached` can
    // never fire: clearing the cap here would leave a blank box with no way
    // out of it.
    expect(h.result.current.stalled).toBe(true);
    expect(h.result.current.footer?.props).toMatchObject({ loading: false, stalled: true });
  });
});

describe('useThreadListPaging — leaving a conversation', () => {
  it('leaves the OLD conversation when the screen switches', () => {
    const h = renderPaging();
    expect(mockLeave).not.toHaveBeenCalled();

    h.rerender({ conversationId: 'group-2' });
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledWith('group-1');
  });

  it('leaves on unmount', () => {
    const h = renderPaging();
    h.unmount();

    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledWith('group-1');
  });

  it('leaves nothing when there was no conversation', () => {
    const h = renderPaging({ conversationId: null });
    h.unmount();

    expect(mockLeave).not.toHaveBeenCalled();
  });

  it('does not touch state after an unmount mid-page', async () => {
    let release: (r: LoadMoreResult) => void = () => {};
    mockLoadMore.mockImplementation(
      () =>
        new Promise<LoadMoreResult>((resolve) => {
          release = resolve;
        }),
    );
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});

    const h = renderPaging();
    act(() => {
      h.result.current.onEndReached();
    });
    h.unmount();
    await act(async () => {
      release(result({ newIdCount: 0 }));
    });

    // No "update on an unmounted component" warning, and no further pages.
    expect(warn).not.toHaveBeenCalled();
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
