/**
 * Tests for pendingWrapClock — the persisted "waiting since" clock behind the
 * 24h pending-wrap bound (#937).
 *
 * What is pinned here is the FAILURE DIRECTION as much as the arithmetic. The
 * bound is the one thing that can turn "the key is on its way" into "this is
 * unreadable", so every degraded input — no userId, no MMKV, a corrupt blob, a
 * clock that jumped, a full table — has to come out as "not past the bound".
 * A clock that cannot read itself must never declare a conversation dead.
 */

const mockMMKV = { ready: true, store: new Map<string, string>(), throwOnGet: false };

jest.mock('../../../stores/middleware/persistence', () => ({
  isMMKVInitialized: () => mockMMKV.ready,
  getMMKVInstance: () => ({
    getString: (key: string) => {
      if (mockMMKV.throwOnGet) throw new Error('MMKV read failed');
      return mockMMKV.store.get(key);
    },
    set: (key: string, value: string) => {
      mockMMKV.store.set(key, value);
    },
    remove: (key: string) => {
      mockMMKV.store.delete(key);
    },
  }),
}));

const mockState = { userId: 'user-1' as string | null };
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => mockState),
  },
}));

import { PENDING_WRAP_BOUND_MS } from '../groupKeyErrors';
import {
  notePendingWrap,
  isPendingWrapPastBound,
  clearPendingWrap,
  prunePendingWraps,
  clearAllPendingWraps,
  _resetPendingWrapClockForTesting,
  _getPendingWrapMirrorForTesting as mirror,
} from '../pendingWrapClock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'orbital:pending-wrap-since:v1';
const GROUP = 'group-1';
/** Comfortably after the module's plausibility floor (2026-01-01). */
const NOW = Date.UTC(2026, 5, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

function storedBlob(): { v?: unknown; owner?: unknown; since?: Record<string, number> } | null {
  const raw = mockMMKV.store.get(STORAGE_KEY);
  return raw === undefined ? null : JSON.parse(raw);
}

function seedBlob(owner: string, since: Record<string, number>, v = 1): void {
  mockMMKV.store.set(STORAGE_KEY, JSON.stringify({ v, owner, since }));
}

/**
 * Re-require the module, as a relaunch would. The MMKV mock's backing map is
 * test state, so it survives the reload — which is the whole point of
 * persisting the clock.
 */
function reloadClock(): typeof import('../pendingWrapClock') {
  jest.resetModules();
  return require('../pendingWrapClock');
}

beforeEach(() => {
  mockMMKV.ready = true;
  mockMMKV.throwOnGet = false;
  mockMMKV.store.clear();
  mockState.userId = 'user-1';
  _resetPendingWrapClockForTesting();
});

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

describe('notePendingWrap', () => {
  it('keeps the FIRST mark, so re-reading a pending group does not restart it', () => {
    notePendingWrap(GROUP, NOW);
    notePendingWrap(GROUP, NOW + 60_000);
    notePendingWrap(GROUP, NOW + DAY_MS);

    expect(mirror()).toEqual({ [GROUP]: NOW });
  });

  it('persists the mark under the signed-in owner', () => {
    notePendingWrap(GROUP, NOW);

    expect(storedBlob()).toEqual({ v: 1, owner: 'user-1', since: { [GROUP]: NOW } });
  });

  it('is per group', () => {
    notePendingWrap('a', NOW);
    notePendingWrap('b', NOW + 1000);

    expect(mirror()).toEqual({ a: NOW, b: NOW + 1000 });
  });
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

describe('isPendingWrapPastBound', () => {
  it('is false for a group that was never marked', () => {
    expect(isPendingWrapPastBound(GROUP, NOW)).toBe(false);
  });

  it('is false 1 ms before the bound and true exactly on it', () => {
    notePendingWrap(GROUP, NOW);

    expect(PENDING_WRAP_BOUND_MS).toBe(DAY_MS);
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS - 1)).toBe(false);
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
  });

  it('stays past the bound on later reads', () => {
    notePendingWrap(GROUP, NOW);

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS * 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clock plausibility
// ---------------------------------------------------------------------------

describe('implausible marks are re-marked, never trusted', () => {
  it('re-marks a mark that is in the future (a backwards clock jump)', () => {
    notePendingWrap(GROUP, NOW);

    const jumpedBack = NOW - DAY_MS;
    expect(isPendingWrapPastBound(GROUP, jumpedBack)).toBe(false);
    expect(mirror()).toEqual({ [GROUP]: jumpedBack });
  });

  it('re-marks through notePendingWrap too', () => {
    notePendingWrap(GROUP, NOW);
    notePendingWrap(GROUP, NOW - DAY_MS);

    expect(mirror()).toEqual({ [GROUP]: NOW - DAY_MS });
  });

  it('re-marks a stored mark below the floor instead of calling it expired', () => {
    // The case the floor exists for: an unsynced device reports 1970, which is
    // "past the bound" by half a century.
    seedBlob('user-1', { [GROUP]: 0 });

    expect(isPendingWrapPastBound(GROUP, NOW)).toBe(false);
    expect(mirror()).toEqual({ [GROUP]: NOW });
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('ownership', () => {
  it('discards a blob that belongs to a different account', () => {
    seedBlob('other-user', { [GROUP]: NOW });

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(mirror()).toEqual({});
    expect(storedBlob()).toBeNull();
  });

  it('keeps the blob when the userId is merely unknown yet', () => {
    seedBlob('user-1', { [GROUP]: NOW });
    mockState.userId = null;

    // Fails toward pending: no account, no verdict.
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(storedBlob()).toEqual({ v: 1, owner: 'user-1', since: { [GROUP]: NOW } });

    // …and once the user IS known, the stored mark is honoured.
    mockState.userId = 'user-1';
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
  });

  it('drops the mirror when the account changes mid-session', () => {
    notePendingWrap(GROUP, NOW);
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);

    mockState.userId = 'user-2';

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(mirror()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Lazy, retryable load
// ---------------------------------------------------------------------------

describe('lazy load', () => {
  it('writes through a mark taken while MMKV was down but the user was known', () => {
    mockMMKV.ready = false;

    notePendingWrap(GROUP, NOW);
    expect(mirror()).toEqual({ [GROUP]: NOW });
    expect(mockMMKV.store.size).toBe(0);

    // Bootstrap finishes: the next access loads, writes the memory-only mark
    // through, and honours it.
    mockMMKV.ready = true;

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
    expect(storedBlob()).toEqual({ v: 1, owner: 'user-1', since: { [GROUP]: NOW } });

    // And it survives the relaunch the bound exists for.
    const reloaded = reloadClock();
    expect(reloaded.isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
  });

  /**
   * A crypto touch with no signed-in user — during account teardown, or before
   * `setUser` on a cold launch — must not hand its mark to whoever logs in
   * next: that would be the previous account's group id, and a clock the new
   * account never started.
   */
  it('drops a mark taken with no signed-in user when an owner is established', () => {
    mockState.userId = null;

    notePendingWrap(GROUP, NOW);
    expect(mirror()).toEqual({ [GROUP]: NOW });
    expect(storedBlob()).toBeNull();

    mockState.userId = 'user-2';

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(mirror()).toEqual({});
    expect(storedBlob()).toBeNull();

    // The group is still pending, so the next read restarts the clock honestly.
    notePendingWrap(GROUP, NOW + PENDING_WRAP_BOUND_MS);
    expect(storedBlob()).toEqual({
      v: 1,
      owner: 'user-2',
      since: { [GROUP]: NOW + PENDING_WRAP_BOUND_MS },
    });
  });

  it('keeps the EARLIER of a stored and a memory-only mark', () => {
    mockMMKV.ready = false;
    notePendingWrap(GROUP, NOW + DAY_MS);

    seedBlob('user-1', { [GROUP]: NOW });
    mockMMKV.ready = true;

    expect(isPendingWrapPastBound(GROUP, NOW + DAY_MS)).toBe(true);
    expect(mirror()).toEqual({ [GROUP]: NOW });
  });

  it('survives a corrupt blob by dropping it', () => {
    mockMMKV.store.set(STORAGE_KEY, '{not json');

    expect(isPendingWrapPastBound(GROUP, NOW)).toBe(false);
    expect(storedBlob()).toBeNull();

    notePendingWrap(GROUP, NOW);
    expect(storedBlob()).toEqual({ v: 1, owner: 'user-1', since: { [GROUP]: NOW } });
  });

  it('drops a blob from an unknown version', () => {
    seedBlob('user-1', { [GROUP]: NOW }, 2);

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(storedBlob()).toBeNull();
  });

  it('ignores non-numeric stored values', () => {
    mockMMKV.store.set(
      STORAGE_KEY,
      JSON.stringify({ v: 1, owner: 'user-1', since: { [GROUP]: 'yesterday', other: NOW } }),
    );

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    expect(mirror()).toEqual({ other: NOW });
  });

  it('retries IN SESSION when the read itself throws, without clobbering the blob', () => {
    seedBlob('user-1', { [GROUP]: NOW });
    const untouched = mockMMKV.store.get(STORAGE_KEY);
    mockMMKV.throwOnGet = true;

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(false);
    // A write while the blob is unread would overwrite marks we never saw.
    notePendingWrap('other', NOW);
    expect(mockMMKV.store.get(STORAGE_KEY)).toBe(untouched);

    // No reload: the same module instance retries and honours the stored mark.
    mockMMKV.throwOnGet = false;
    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
    expect(storedBlob()?.since).toEqual({ [GROUP]: NOW, other: NOW });
  });
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

describe('entry cap', () => {
  it('refuses new marks at the cap rather than evicting a stuck group', () => {
    for (let i = 0; i < 256; i++) {
      notePendingWrap(`g-${i}`, NOW);
    }
    expect(Object.keys(mirror())).toHaveLength(256);

    notePendingWrap('g-new', NOW + DAY_MS);

    // The newcomer is untracked — it keeps the pending copy, which is the
    // pre-#937 behaviour…
    expect(mirror()['g-new']).toBeUndefined();
    expect(isPendingWrapPastBound('g-new', NOW + DAY_MS * 10)).toBe(false);
    // …and the oldest mark, the one the bound exists for, is intact.
    expect(mirror()['g-0']).toBe(NOW);
    expect(Object.keys(mirror())).toHaveLength(256);
  });

  it('still re-marks an implausible existing entry at the cap', () => {
    for (let i = 0; i < 256; i++) {
      notePendingWrap(`g-${i}`, NOW);
    }

    notePendingWrap('g-0', NOW - DAY_MS);

    expect(mirror()['g-0']).toBe(NOW - DAY_MS);
  });
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

describe('clearPendingWrap', () => {
  it('removes the entry and rewrites the blob', () => {
    notePendingWrap('a', NOW);
    notePendingWrap('b', NOW);

    clearPendingWrap('a');

    expect(mirror()).toEqual({ b: NOW });
    expect(storedBlob()?.since).toEqual({ b: NOW });
  });

  it('does not write when there is nothing to clear', () => {
    notePendingWrap('a', NOW);
    const before = mockMMKV.store.get(STORAGE_KEY);

    clearPendingWrap('b');

    expect(mockMMKV.store.get(STORAGE_KEY)).toBe(before);
    expect(mirror()).toEqual({ a: NOW });
  });
});

describe('prunePendingWraps', () => {
  it('drops groups the server no longer returns', () => {
    notePendingWrap('kept', NOW);
    notePendingWrap('dissolved', NOW);

    prunePendingWraps(['kept', 'never-pending']);

    expect(mirror()).toEqual({ kept: NOW });
    expect(storedBlob()?.since).toEqual({ kept: NOW });
  });

  it('is a no-op when nothing is tracked', () => {
    prunePendingWraps(['a']);

    expect(mirror()).toEqual({});
    expect(storedBlob()).toBeNull();
  });
});

describe('clearAllPendingWraps', () => {
  it('clears unconditionally, with the userId already gone', () => {
    notePendingWrap(GROUP, NOW);
    // The wipe order: the store is cleared before the crypto teardown runs.
    mockState.userId = null;

    clearAllPendingWraps();

    expect(mirror()).toEqual({});
    expect(storedBlob()).toBeNull();
  });

  it('leaves the clock unloaded, so the next account reloads under its own owner', () => {
    notePendingWrap(GROUP, NOW);
    clearAllPendingWraps();

    // A blob written by whatever ran during the wipe is re-read, not assumed.
    seedBlob('user-2', { [GROUP]: NOW });
    mockState.userId = 'user-2';

    expect(isPendingWrapPastBound(GROUP, NOW + PENDING_WRAP_BOUND_MS)).toBe(true);
  });
});
