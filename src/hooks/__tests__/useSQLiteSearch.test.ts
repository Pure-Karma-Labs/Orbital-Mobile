/**
 * Tests for useSQLiteSearch -- debounced FTS5 search hook.
 *
 * Uses a minimal renderHook helper since @testing-library/react-native
 * is not installed. The hook is tested through React.createElement +
 * react-test-renderer, matching the project's existing test patterns.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSQLiteSearch } from '../useSQLiteSearch';

// ---------------------------------------------------------------------------
// Mock the search repository
// ---------------------------------------------------------------------------

const mockSearchAll = jest.fn<string[], [string, string]>(() => []);

jest.mock('../../database/repositories/searchRepository', () => ({
  searchAll: (...args: [string, string]) => mockSearchAll(...args),
}));

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

describe('useSQLiteSearch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSearchAll.mockReset();
    mockSearchAll.mockReturnValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns empty results when search text is empty', () => {
    const { result } = renderHook(() => useSQLiteSearch('conv-1'));
    expect(result.current.searchText).toBe('');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.resultThreadIds).toEqual([]);
  });

  it('does not call searchAll before debounce fires', () => {
    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    act(() => {
      result.current.setSearchText('hello');
    });

    expect(result.current.searchText).toBe('hello');
    expect(result.current.isSearching).toBe(false);
    expect(mockSearchAll).not.toHaveBeenCalled();
  });

  it('calls searchAll after debounce and returns results', () => {
    mockSearchAll.mockReturnValue(['thread-1', 'thread-2']);

    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    act(() => {
      result.current.setSearchText('test query');
    });

    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    expect(mockSearchAll).toHaveBeenCalledWith('conv-1', 'test query');
    expect(result.current.resultThreadIds).toEqual(['thread-1', 'thread-2']);
  });

  it('debounces rapid typing (only the final value fires)', () => {
    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    act(() => {
      result.current.setSearchText('h');
    });
    act(() => {
      jest.advanceTimersByTime(50);
    });
    act(() => {
      result.current.setSearchText('he');
    });
    act(() => {
      jest.advanceTimersByTime(50);
    });
    act(() => {
      result.current.setSearchText('hello');
    });

    // Debounce hasn't fired yet
    expect(result.current.isSearching).toBe(false);
    expect(mockSearchAll).not.toHaveBeenCalled();

    // Fire the debounce from last input
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    expect(mockSearchAll).toHaveBeenCalledTimes(1);
    expect(mockSearchAll).toHaveBeenCalledWith('conv-1', 'hello');
  });

  it('clearing input immediately exits search mode', () => {
    mockSearchAll.mockReturnValue(['thread-1']);

    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    // Enter search mode
    act(() => {
      result.current.setSearchText('test');
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.isSearching).toBe(true);

    // Backspace to empty
    act(() => {
      result.current.setSearchText('');
    });

    expect(result.current.searchText).toBe('');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.resultThreadIds).toEqual([]);
  });

  it('clearSearch resets both searchText and isSearching immediately', () => {
    mockSearchAll.mockReturnValue(['thread-1']);

    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    // Enter search mode
    act(() => {
      result.current.setSearchText('hello');
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
    expect(result.current.resultThreadIds).toEqual([]);
  });

  it('returns empty results when conversationId is null', () => {
    const { result } = renderHook(() => useSQLiteSearch(null, 200));

    act(() => {
      result.current.setSearchText('test');
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.resultThreadIds).toEqual([]);
    // searchAll should not be called with null conversationId
    expect(mockSearchAll).not.toHaveBeenCalled();
  });

  it('cancels pending debounce on clearSearch', () => {
    const { result } = renderHook(() => useSQLiteSearch('conv-1', 200));

    act(() => {
      result.current.setSearchText('hello');
    });

    // Clear before debounce fires
    act(() => {
      result.current.clearSearch();
    });

    // Advance past debounce -- should NOT fire
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(result.current.isSearching).toBe(false);
    expect(mockSearchAll).not.toHaveBeenCalled();
  });
});
