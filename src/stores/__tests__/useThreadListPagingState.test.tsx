/**
 * Tests for the `useThreadListPagingState` selector (#923).
 *
 * The selector returns the RAW slot `threadListWalk` wrote, so zustand's
 * default `Object.is` comparison is correct and a list screen re-renders
 * exactly when its own conversation's paging state moves.
 *
 * The fallback is the part worth pinning: a fresh `{…}` per call would fail
 * `Object.is` on every render and re-render the list on every unrelated store
 * write — the footer of a list with no paging state at all would be the most
 * expensive thing on the screen.
 *
 * The store module is replaced with a real zustand store: importing
 * `src/stores/useAppStore` pulls in MMKV persistence, which does not load
 * under jest. Same shape as `useGroupKeyGeneration.test.tsx`.
 */

import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ThreadListPagingState } from '../../types/store';

interface TestState {
  threadListPaging: Record<string, ThreadListPagingState>;
}

jest.mock('../useAppStore', () => {
  // require, not import: jest.mock factories are hoisted above the imports.
  const { create: createStore } = require('zustand');
  return {
    useAppStore: createStore(() => ({ threadListPaging: {} })),
  };
});

import { useAppStore, useThreadListPagingState } from '..';

const store = useAppStore as unknown as {
  setState: (partial: Partial<TestState>) => void;
};

function slot(overrides: Partial<ThreadListPagingState> = {}): ThreadListPagingState {
  return {
    hasMore: true,
    loadingMore: false,
    loadMoreFailed: false,
    totalCount: 120,
    ...overrides,
  };
}

/** Renders the selector and returns every value it has seen, in order. */
function renderSelector(conversationId: string | null): ThreadListPagingState[] {
  const seen: ThreadListPagingState[] = [];

  function Probe(): React.JSX.Element {
    const paging = useThreadListPagingState(conversationId);
    seen.push(paging);
    return <Text>{String(paging.hasMore)}</Text>;
  }

  act(() => {
    create(<Probe />);
  });
  return seen;
}

beforeEach(() => {
  store.setState({ threadListPaging: {} });
});

describe('useThreadListPagingState (#923)', () => {
  it('returns the conversation’s own slot, by identity', () => {
    const own = slot();
    store.setState({ threadListPaging: { 'conv-1': own, 'conv-2': slot({ hasMore: false }) } });

    const seen = renderSelector('conv-1');

    expect(seen[seen.length - 1]).toBe(own);
  });

  it('falls back to a shared frozen default, never a fresh object', () => {
    const first = renderSelector('conv-unknown');
    const second = renderSelector('conv-also-unknown');
    const nullId = renderSelector(null);

    const a = first[first.length - 1];
    const b = second[second.length - 1];
    const c = nullId[nullId.length - 1];

    // Same object every time — this is what keeps `Object.is` from reporting a
    // change on every unrelated store write.
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toEqual({
      hasMore: false,
      loadingMore: false,
      loadMoreFailed: false,
      totalCount: 0,
    });
  });

  it('falls back to the frozen default when this conversation’s slot is removed', () => {
    store.setState({ threadListPaging: { 'conv-1': slot() } });
    const seen: ThreadListPagingState[] = [];

    function Probe(): React.JSX.Element {
      const paging = useThreadListPagingState('conv-1');
      seen.push(paging);
      return <Text>{String(paging.loadingMore)}</Text>;
    }

    act(() => {
      create(<Probe />);
    });
    const afterMount = seen.length;

    act(() => {
      store.setState({
        threadListPaging: { 'conv-1': slot(), 'conv-2': slot({ hasMore: false }) },
      });
    });
    // A different conversation's slot arrived; ours is a new object with the
    // same values, so `Object.is` DOES see a change — that is the price of
    // returning the raw slot, and it is bounded by how often the walk writes.
    const afterOtherConversation = seen.length;

    act(() => {
      store.setState({ threadListPaging: { 'conv-2': slot({ hasMore: false }) } });
    });

    // Ours is gone: the frozen default takes over.
    expect(seen[seen.length - 1]).toEqual({
      hasMore: false,
      loadingMore: false,
      loadMoreFailed: false,
      totalCount: 0,
    });
    expect(afterOtherConversation).toBeGreaterThanOrEqual(afterMount);
  });
});
