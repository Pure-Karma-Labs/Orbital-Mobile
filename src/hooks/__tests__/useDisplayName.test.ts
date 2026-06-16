import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useDisplayName } from '../useDisplayName';

// ---------------------------------------------------------------------------
// Mock store
// ---------------------------------------------------------------------------

let mockState: Record<string, unknown> = {};

jest.mock('../../stores', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

// ---------------------------------------------------------------------------
// Minimal renderHook helper
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

describe('useDisplayName', () => {
  afterEach(() => {
    mockState = {};
  });

  it('returns "Deleted User" when authorId is null', () => {
    mockState = { userId: 'u-1', displayName: null, contacts: {} };
    const { result } = renderHook(() => useDisplayName(null, 'fallback'));
    expect(result.current).toBe('Deleted User');
  });

  it('returns "Deleted User" when authorId is undefined', () => {
    mockState = { userId: 'u-1', displayName: null, contacts: {} };
    const { result } = renderHook(() => useDisplayName(undefined, 'fallback'));
    expect(result.current).toBe('Deleted User');
  });

  it('returns auth displayName for the current user', () => {
    mockState = { userId: 'u-1', displayName: 'Mom', contacts: {} };
    const { result } = renderHook(() => useDisplayName('u-1', 'jane'));
    expect(result.current).toBe('Mom');
  });

  it('falls back to username when current user has no displayName', () => {
    mockState = { userId: 'u-1', displayName: null, contacts: {} };
    const { result } = renderHook(() => useDisplayName('u-1', 'jane'));
    expect(result.current).toBe('jane');
  });

  it('returns contact displayName for other users', () => {
    mockState = {
      userId: 'u-1',
      displayName: null,
      contacts: { 'u-2': { displayName: 'Dad' } },
    };
    const { result } = renderHook(() => useDisplayName('u-2', 'john'));
    expect(result.current).toBe('Dad');
  });

  it('falls back to username when contact has no displayName', () => {
    mockState = {
      userId: 'u-1',
      displayName: null,
      contacts: { 'u-2': { displayName: null } },
    };
    const { result } = renderHook(() => useDisplayName('u-2', 'john'));
    expect(result.current).toBe('john');
  });

  it('falls back to username when contact does not exist', () => {
    mockState = { userId: 'u-1', displayName: null, contacts: {} };
    const { result } = renderHook(() => useDisplayName('u-unknown', 'bob'));
    expect(result.current).toBe('bob');
  });
});
