/**
 * Tests for the `useGroupKeyGeneration` selector (#912).
 *
 * Both branches are load-bearing and neither is obvious:
 * - keyed by `groupId`, so a heal in one orbit does not re-run every open
 *   screen's load effect;
 * - the TOTAL across groups for a `null` id, which is what a ThreadDetail
 *   opened from a push notification reads before it knows its conversation —
 *   the thread never decrypted, so there is no id to key on, and that is
 *   exactly the screen that must reload when the heal lands.
 *
 * The store module is replaced with a real zustand store: importing
 * `src/stores/useAppStore` pulls in MMKV persistence, which does not load
 * under jest. Same shape as `useContactForConversation.test.tsx`.
 */

import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

interface TestState {
  groupKeyGeneration: Record<string, number>;
}

jest.mock('../useAppStore', () => {
  // require, not import: jest.mock factories are hoisted above the imports.
  const { create: createStore } = require('zustand');
  return {
    useAppStore: createStore(() => ({ groupKeyGeneration: {} })),
  };
});

import { useAppStore, useGroupKeyGeneration } from '..';

const store = useAppStore as unknown as {
  setState: (partial: Partial<TestState>) => void;
};

/** Renders the selector and returns every value it has seen, in order. */
function renderSelector(groupId: string | null): number[] {
  const seen: number[] = [];

  function Probe(): React.JSX.Element {
    const generation = useGroupKeyGeneration(groupId);
    seen.push(generation);
    return <Text>{String(generation)}</Text>;
  }

  act(() => {
    create(<Probe />);
  });
  return seen;
}

function last(values: number[]): number {
  return values[values.length - 1];
}

beforeEach(() => {
  store.setState({ groupKeyGeneration: {} });
});

describe('useGroupKeyGeneration — keyed branch', () => {
  it('returns that group\'s count', () => {
    store.setState({ groupKeyGeneration: { 'g-1': 2, 'g-2': 5 } });
    expect(last(renderSelector('g-1'))).toBe(2);
  });

  it('returns 0 for a group with no deliveries this session', () => {
    store.setState({ groupKeyGeneration: { 'g-2': 5 } });
    // 0, not undefined: the screens compare it against a previous value, and
    // undefined === undefined would hide the first delivery.
    expect(last(renderSelector('g-1'))).toBe(0);
  });

  it('ignores another group\'s delivery', () => {
    const seen = renderSelector('g-1');
    expect(last(seen)).toBe(0);
    const rendersBefore = seen.length;

    act(() => {
      store.setState({ groupKeyGeneration: { 'g-2': 1 } });
    });

    // The value is a NUMBER, so zustand's default Object.is comparison holds
    // and the subscriber is not re-rendered at all. A `useShallow` over the
    // whole record would re-render every screen on any group's bump.
    expect(seen).toHaveLength(rendersBefore);
    expect(last(seen)).toBe(0);
  });

  it('re-renders with the new count when its own group is bumped', () => {
    const seen = renderSelector('g-1');

    act(() => {
      store.setState({ groupKeyGeneration: { 'g-1': 1 } });
    });

    expect(last(seen)).toBe(1);
  });
});

describe('useGroupKeyGeneration — null (total) branch', () => {
  it('sums every group', () => {
    store.setState({ groupKeyGeneration: { 'g-1': 2, 'g-2': 5, 'g-3': 1 } });
    expect(last(renderSelector(null))).toBe(8);
  });

  it('is 0 when nothing has been delivered', () => {
    expect(last(renderSelector(null))).toBe(0);
  });

  it('changes on ANY group\'s delivery — the deep-link case', () => {
    store.setState({ groupKeyGeneration: { 'g-1': 1 } });
    const seen = renderSelector(null);
    expect(last(seen)).toBe(1);

    act(() => {
      store.setState({ groupKeyGeneration: { 'g-1': 1, 'g-2': 1 } });
    });

    expect(last(seen)).toBe(2);
  });

  it('drops back to 0 when the generations are cleared', () => {
    store.setState({ groupKeyGeneration: { 'g-1': 3 } });
    const seen = renderSelector(null);
    expect(last(seen)).toBe(3);

    act(() => {
      store.setState({ groupKeyGeneration: {} });
    });

    expect(last(seen)).toBe(0);
  });
});
