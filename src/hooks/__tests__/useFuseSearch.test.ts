/**
 * Tests for useFuseSearch — debounced fuzzy search hook.
 *
 * Uses a minimal renderHook helper since @testing-library/react-native
 * is not installed. The hook is tested through React.createElement +
 * react-test-renderer, which follows the project's existing test patterns.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { IFuseOptions } from 'fuse.js';
import { useFuseSearch } from '../useFuseSearch';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface TestItem {
  id: string;
  name: string;
  description: string;
}

const items: TestItem[] = [
  { id: '1', name: 'Apple', description: 'A red fruit' },
  { id: '2', name: 'Banana', description: 'A yellow fruit' },
  { id: '3', name: 'Cherry', description: 'A small red fruit' },
  { id: '4', name: 'Dragonfruit', description: 'An exotic fruit' },
];

const options: IFuseOptions<TestItem> = {
  threshold: 0.3,
  keys: ['name', 'description'],
};

// ---------------------------------------------------------------------------
// Minimal renderHook helper (no external dependency)
// ---------------------------------------------------------------------------

function renderHook<T>(hook: () => T): { result: { current: T }; renderer: ReactTestRenderer } {
  const result = { current: undefined as unknown as T };

  function TestComponent(): null {
    result.current = hook();
    return null;
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(TestComponent));
  });
  return { result, renderer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFuseSearch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the full list when search text is empty', () => {
    const { result } = renderHook(() => useFuseSearch(items, options));
    expect(result.current.results).toEqual(items);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.searchText).toBe('');
  });

  it('filters results after debounce fires', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    act(() => {
      result.current.setSearchText('Apple');
    });

    // Before debounce — still returns full list
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toEqual(items);

    // Fire the debounce timer
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.results.length).toBeGreaterThan(0);
    expect(result.current.results[0]).toEqual(
      expect.objectContaining({ name: 'Apple' }),
    );
  });

  it('performs fuzzy matching', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    act(() => {
      result.current.setSearchText('Aple');
    });

    act(() => {
      jest.advanceTimersByTime(200);
    });

    // Fuzzy match should find "Apple" even with typo
    expect(result.current.isSearching).toBe(true);
    const names = result.current.results.map((r: TestItem) => r.name);
    expect(names).toContain('Apple');
  });

  it('returns empty results when nothing matches', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    act(() => {
      result.current.setSearchText('zzzzzzz');
    });

    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.results).toHaveLength(0);
  });

  it('clearSearch resets both searchText and isSearching immediately', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    // Enter search mode
    act(() => {
      result.current.setSearchText('Apple');
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.isSearching).toBe(true);

    // Clear
    act(() => {
      result.current.clearSearch();
    });

    expect(result.current.searchText).toBe('');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toEqual(items);
  });

  it('debounces rapid typing (only the final value fires)', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    act(() => {
      result.current.setSearchText('A');
    });
    act(() => {
      jest.advanceTimersByTime(50);
    });
    act(() => {
      result.current.setSearchText('Ap');
    });
    act(() => {
      jest.advanceTimersByTime(50);
    });
    act(() => {
      result.current.setSearchText('App');
    });

    // Still not searching — debounce hasn't fired
    expect(result.current.isSearching).toBe(false);

    // Advance past debounce from last input
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    // Should match "Apple" based on "App"
    expect(result.current.results.length).toBeGreaterThan(0);
  });

  it('clearing the input immediately exits search mode (no debounce delay)', () => {
    const { result } = renderHook(() => useFuseSearch(items, options, 200));

    // Enter search mode
    act(() => {
      result.current.setSearchText('Banana');
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.isSearching).toBe(true);

    // Backspace to empty string
    act(() => {
      result.current.setSearchText('');
    });

    // Should immediately exit search mode — no 200ms wait
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toEqual(items);
  });
});
