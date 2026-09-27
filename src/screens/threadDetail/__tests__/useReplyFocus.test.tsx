/**
 * Tests for useReplyFocus — the scroll + highlight machinery behind deep
 * links, the "↳ Replying to @x" jump and the post-send landing (#821).
 *
 * Fake timers throughout: every give-up, highlight-clear and retry path in
 * this hook is a timeout, and the whole point of the suite is to prove they
 * fire exactly once, for the right request, and never after unmount.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  useReplyFocus,
  makeExpandAncestors,
  type ReplyFocusApi,
  type ReplyFocusListHandle,
} from '../useReplyFocus';
import type { ReplyTreeInput, ReplyTreeNode } from '../../../utils/replyTree';

type Row = { reply: { id: string } };

const row = (id: string): Row => ({ reply: { id } });

interface Harness {
  api: { current: ReplyFocusApi };
  list: { scrollToIndex: jest.Mock; scrollToOffset: jest.Mock };
  expandAncestors: jest.Mock;
  setRows: (rows: Row[]) => void;
  setHeaderHeight: (height: number) => void;
  unmount: () => void;
  renders: () => number;
}

function setup(initialRows: Row[] = [], initialHeaderHeight = 0): Harness {
  const list = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn() };
  const listRef: React.RefObject<ReplyFocusListHandle | null> = { current: list };
  const expandAncestors = jest.fn();
  const api = { current: undefined as unknown as ReplyFocusApi };
  let renderCount = 0;

  function Probe({
    rows,
    headerHeight,
  }: {
    rows: Row[];
    headerHeight: number;
  }): null {
    renderCount++;
    api.current = useReplyFocus({ listRef, rows, expandAncestors, headerHeight });
    return null;
  }

  let rows = initialRows;
  let headerHeight = initialHeaderHeight;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(Probe, { rows, headerHeight }));
  });

  const update = (): void => {
    act(() => {
      renderer.update(React.createElement(Probe, { rows, headerHeight }));
    });
  };

  return {
    api,
    list,
    expandAncestors,
    setRows: (next) => {
      rows = next;
      update();
    },
    setHeaderHeight: (next) => {
      headerHeight = next;
      update();
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
    renders: () => renderCount,
  };
}

/** Issue a focus request inside act(), so the resolve effect flushes. */
function request(
  h: Harness,
  id: string,
  source: 'deeplink' | 'jump' | 'landing',
): void {
  act(() => {
    h.api.current.requestFocus(id, { source });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Immediate resolution
// ---------------------------------------------------------------------------

describe('useReplyFocus — resolving', () => {
  it('scrolls to an already-visible row on the next commit, with no content-size event', () => {
    const h = setup([row('a'), row('b'), row('c')]);
    request(h, 'b', 'jump');

    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(h.list.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      animated: true,
      viewPosition: 0.3,
    });
    expect(h.api.current.highlightedId).toBe('b');
  });

  it('looks the index up BY ID at resolve time, not at request time', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'deeplink');
    expect(h.list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));

    // A tree insert moves 'b' down. A NEW request must not reuse index 1.
    h.setRows([row('a'), row('a1'), row('a2'), row('b')]);
    request(h, 'b', 'jump');
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 3 }),
    );
  });

  it('waits for a row that is not loaded yet, then resolves when it arrives', () => {
    const h = setup([row('a')]);
    request(h, 'z', 'deeplink');
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.api.current.highlightedId).toBeNull();

    h.setRows([row('a'), row('z')]);
    expect(h.list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
    expect(h.api.current.highlightedId).toBe('z');
  });

  it('resolves each request exactly once, however often the rows change', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'jump');
    h.setRows([row('a'), row('b'), row('c')]);
    h.setRows([row('a'), row('b'), row('c'), row('d')]);
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Highlight lifecycle
// ---------------------------------------------------------------------------

describe('useReplyFocus — highlight', () => {
  it('turns the highlight on at resolve and off 2s later', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'jump');
    expect(h.api.current.highlightedId).toBe('b');

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(h.api.current.highlightedId).toBe('b');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(h.api.current.highlightedId).toBeNull();
  });

  it('never lights two rows at once — a new request drops the old highlight', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'a', 'jump');
    expect(h.api.current.highlightedId).toBe('a');

    request(h, 'b', 'jump');
    expect(h.api.current.highlightedId).toBe('b');

    // The FIRST request's 2s highlight clear must not fire against 'b'.
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(h.api.current.highlightedId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('useReplyFocus — a new request cancels the previous one', () => {
  it('drops a pending (unresolved) request when a second one is issued', () => {
    const h = setup([row('a')]);
    request(h, 'unloaded', 'deeplink');
    request(h, 'a', 'jump');

    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(h.list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));

    // 'unloaded' arriving later belongs to a cancelled request.
    h.setRows([row('a'), row('unloaded')]);
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(h.api.current.highlightedId).toBe('a');
  });

  it('does not let the cancelled request\'s give-up timer clear the new highlight', () => {
    const h = setup([row('a')]);
    request(h, 'unloaded', 'jump'); // 3s window
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    request(h, 'a', 'landing');
    expect(h.api.current.highlightedId).toBe('a');

    // The first window would have expired at t=3000.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(h.api.current.highlightedId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// Landing re-resolution
// ---------------------------------------------------------------------------

describe('useReplyFocus — landing', () => {
  it('re-scrolls on a content-size change inside its 3s window', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'landing');
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);

    // A gallery paints above the row and pushes it out of view.
    act(() => {
      h.api.current.onContentSizeChange();
    });
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1 }),
    );
  });

  it('re-aims by id, so a row that MOVED is still the one scrolled to', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'landing');
    h.setRows([row('a'), row('a1'), row('b')]);
    act(() => {
      h.api.current.onContentSizeChange();
    });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 2 }),
    );
  });

  it('stops re-resolving once the window closes', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'landing');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    act(() => {
      h.api.current.onContentSizeChange();
    });
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('ignores content-size changes for a jump or deep link', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'jump');
    act(() => {
      h.api.current.onContentSizeChange();
    });
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Collapsed targets
// ---------------------------------------------------------------------------

describe('useReplyFocus — collapsed targets', () => {
  it('asks for the ancestors to be expanded before resolving', () => {
    const h = setup([row('a')]);
    request(h, 'deep', 'deeplink');
    expect(h.expandAncestors).toHaveBeenCalledWith('deep');

    // The screen expands, the row appears, and the request resolves.
    h.setRows([row('a'), row('deep')]);
    expect(h.list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it('stops asking once resolved', () => {
    const h = setup([row('a')]);
    request(h, 'a', 'jump');
    const callsAtResolve = h.expandAncestors.mock.calls.length;
    h.setRows([row('a'), row('b')]);
    expect(h.expandAncestors.mock.calls.length).toBe(callsAtResolve);
  });

  it('makeExpandAncestors keeps Set identity when nothing is collapsed', () => {
    // LOAD-BEARING: identity stability is what stops the resolve effect from
    // re-running on its own output.
    const node = (
      id: string,
      parentId: string | null,
      depth: number,
    ): ReplyTreeNode<ReplyTreeInput> => ({
      reply: { id, parentReplyId: parentId, authorId: 'u', createdAt: 0 },
      depth,
      parentId,
      orphan: false,
      descendantCount: 0,
    });
    const byId = new Map<string, ReplyTreeNode<ReplyTreeInput>>([
      ['child', node('child', 'root', 1)],
      ['root', node('root', null, 0)],
    ]);
    let collapsed: ReadonlySet<string> = new Set(['other']);
    const expand = makeExpandAncestors(
      () => byId,
      (updater) => {
        collapsed = updater(collapsed);
      },
    );

    const before = collapsed;
    expand('child');
    expect(collapsed).toBe(before); // 'root' was not collapsed → same Set

    collapsed = new Set(['root', 'other']);
    expand('child');
    expect(collapsed).not.toContain('root');
    expect(collapsed.has('other')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Give-up windows
// ---------------------------------------------------------------------------

describe('useReplyFocus — timeouts', () => {
  it('gives a deep link 10s before abandoning it', () => {
    const h = setup([row('a')]);
    request(h, 'late', 'deeplink');

    act(() => {
      jest.advanceTimersByTime(9999);
    });
    h.setRows([row('a'), row('late')]);
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('abandons a deep link whose row never arrives', () => {
    const h = setup([row('a')]);
    request(h, 'never', 'deeplink');
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    h.setRows([row('a'), row('never')]);
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.api.current.highlightedId).toBeNull();
  });

  it('gives a jump only 3s', () => {
    const h = setup([row('a')]);
    request(h, 'never', 'jump');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    h.setRows([row('a'), row('never')]);
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scrollToIndex failure fallback
// ---------------------------------------------------------------------------

describe('useReplyFocus — onScrollToIndexFailed', () => {
  it('adds the header height to the estimated offset', () => {
    const h = setup([row('a'), row('b')], 240);
    request(h, 'b', 'jump');
    act(() => {
      h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 100 });
    });
    expect(h.list.scrollToOffset).toHaveBeenCalledWith({
      offset: 340, // 240 header + 100 * 1
      animated: true,
    });
  });

  it('uses the CURRENT header height, not the one captured at mount', () => {
    const h = setup([row('a'), row('b')], 0);
    h.setHeaderHeight(500); // the OP's media finished painting
    request(h, 'b', 'jump');
    act(() => {
      h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 10 });
    });
    expect(h.list.scrollToOffset).toHaveBeenCalledWith({ offset: 510, animated: true });
  });

  it('re-measures the index by id on the retry', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'jump');
    h.list.scrollToIndex.mockClear();

    act(() => {
      h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 100 });
    });
    // Rows shift while the offset scroll runs.
    h.setRows([row('a'), row('a1'), row('b')]);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(h.list.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2 }),
    );
  });

  it('gives up after 3 failures instead of retrying forever', () => {
    const h = setup([row('a'), row('b')]);
    request(h, 'b', 'jump');
    for (let i = 0; i < 3; i++) {
      act(() => {
        h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 100 });
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });
    }
    expect(h.list.scrollToOffset).toHaveBeenCalledTimes(3);

    act(() => {
      h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 100 });
    });
    expect(h.list.scrollToOffset).toHaveBeenCalledTimes(3);
    expect(h.api.current.highlightedId).toBeNull();
  });

  it('does nothing when no request is in flight', () => {
    const h = setup([row('a')]);
    act(() => {
      h.api.current.onScrollToIndexFailed({ index: 0, averageItemLength: 100 });
    });
    expect(h.list.scrollToOffset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unmount
// ---------------------------------------------------------------------------

describe('useReplyFocus — unmount', () => {
  it('cancels every pending timer, so nothing sets state after teardown', () => {
    const errors: unknown[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });
    try {
      const h = setup([row('a'), row('b')]);
      request(h, 'b', 'landing'); // arms the highlight clear AND the window
      h.api.current.onScrollToIndexFailed({ index: 1, averageItemLength: 100 }); // arms the retry
      h.unmount();

      act(() => {
        jest.advanceTimersByTime(60000);
      });
      expect(jest.getTimerCount()).toBe(0);
      expect(errors).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
