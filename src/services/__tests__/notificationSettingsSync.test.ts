/**
 * Tests for notificationSettingsSync (#449, hardened in #678).
 *
 * Covers the server-authoritative overwrite sync (per-call 2xx gating,
 * one-fails-one-succeeds isolation, drain-first + overlay), the coalescing
 * per-target mute runner, per-key pref apply, the persisted replay queue with
 * its owner binding and attempt bound, alert copy, and the epoch lifecycle.
 */

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

const mockSentryAddBreadcrumb = jest.fn();

jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: (...args: unknown[]) => mockSentryAddBreadcrumb(...args),
}));

const mockGetNotificationPrefs = jest.fn();
const mockGetNotificationMutes = jest.fn();
const mockUpdateNotificationPrefs = jest.fn();
const mockMuteTargetApi = jest.fn();
const mockUnmuteTargetApi = jest.fn();

jest.mock('../api/notificationSettings', () => ({
  getNotificationPrefs: (...args: unknown[]) => mockGetNotificationPrefs(...args),
  getNotificationMutes: (...args: unknown[]) => mockGetNotificationMutes(...args),
  updateNotificationPrefs: (...args: unknown[]) => mockUpdateNotificationPrefs(...args),
  muteTargetApi: (...args: unknown[]) => mockMuteTargetApi(...args),
  unmuteTargetApi: (...args: unknown[]) => mockUnmuteTargetApi(...args),
}));

/**
 * Minimal store double backed by real slice-equivalent mutations, so the
 * optimistic-update / rollback assertions observe actual state transitions
 * rather than call counts. applyMuteIntent and the queue actions mirror
 * notificationSlice exactly, including the MAX_PENDING_MUTE_OPS cap — the
 * at-cap and owner-binding tests depend on those semantics being real.
 */
interface PendingMuteOpDouble {
  targetType: string;
  muted: boolean;
  ownerUserId: string;
  attempts: number;
}

const storeState: {
  userId: string | null;
  isAuthenticated: boolean;
  notificationPrefs: Record<string, boolean>;
  mutedTargets: Record<string, string>;
  pendingMuteOps: Record<string, PendingMuteOpDouble>;
} = {
  userId: 'user-1',
  isAuthenticated: true,
  notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
  mutedTargets: {},
  pendingMuteOps: {},
};

const mockSetNotificationPrefs = jest.fn((patch: Record<string, boolean>) => {
  storeState.notificationPrefs = { ...storeState.notificationPrefs, ...patch };
});
const mockSetMutedTargets = jest.fn((targets: Record<string, string>) => {
  storeState.mutedTargets = { ...targets };
});
const mockAddMutedTarget = jest.fn((id: string, type: string) => {
  storeState.mutedTargets = { ...storeState.mutedTargets, [id]: type };
});
const mockRemoveMutedTarget = jest.fn((id: string) => {
  const next = { ...storeState.mutedTargets };
  delete next[id];
  storeState.mutedTargets = next;
});
const mockApplyMuteIntent = jest.fn((id: string, op: PendingMuteOpDouble) => {
  const mutedTargets = { ...storeState.mutedTargets };
  if (op.muted) mutedTargets[id] = op.targetType;
  else delete mutedTargets[id];
  storeState.mutedTargets = mutedTargets;

  const known = storeState.pendingMuteOps[id] !== undefined;
  if (!known && Object.keys(storeState.pendingMuteOps).length >= MAX_PENDING_MUTE_OPS) return;
  storeState.pendingMuteOps = { ...storeState.pendingMuteOps, [id]: op };
});
const mockClearPendingMuteOp = jest.fn((id: string) => {
  if (storeState.pendingMuteOps[id] === undefined) return;
  const next = { ...storeState.pendingMuteOps };
  delete next[id];
  storeState.pendingMuteOps = next;
});
const mockClearPendingMuteOps = jest.fn((ids: string[]) => {
  const next = { ...storeState.pendingMuteOps };
  for (const id of ids) delete next[id];
  storeState.pendingMuteOps = next;
});
const mockBumpPendingMuteAttempts = jest.fn((id: string) => {
  const op = storeState.pendingMuteOps[id];
  if (op === undefined) return;
  storeState.pendingMuteOps = {
    ...storeState.pendingMuteOps,
    [id]: { ...op, attempts: op.attempts + 1 },
  };
});

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: storeState.userId,
      isAuthenticated: storeState.isAuthenticated,
      notificationPrefs: storeState.notificationPrefs,
      mutedTargets: storeState.mutedTargets,
      pendingMuteOps: storeState.pendingMuteOps,
      setNotificationPrefs: mockSetNotificationPrefs,
      setMutedTargets: mockSetMutedTargets,
      addMutedTarget: mockAddMutedTarget,
      removeMutedTarget: mockRemoveMutedTarget,
      applyMuteIntent: mockApplyMuteIntent,
      clearPendingMuteOp: mockClearPendingMuteOp,
      clearPendingMuteOps: mockClearPendingMuteOps,
      bumpPendingMuteAttempts: mockBumpPendingMuteAttempts,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Alert, AppState } from 'react-native';
import {
  syncNotificationSettings,
  toggleMute,
  setPref,
  drainPendingMuteOps,
  clearNotificationSyncState,
  registerForegroundNotificationSettingsSync,
  unregisterForegroundNotificationSettingsSync,
  scheduleNotificationSettingsSync,
} from '../notificationSettingsSync';
import { MAX_PENDING_MUTE_OPS } from '../../stores/slices/notificationSlice';
import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  ServerError,
  ValidationError,
} from '../api/errors';

/**
 * The exact strings the module is allowed to show. Duplicated here on purpose:
 * changing the copy must fail this suite rather than silently ship.
 */
const MUTE_FAILED_COPY = 'Could not update notifications for this. Please try again.';
const PREF_FAILED_COPY = 'Could not save that setting. Please try again.';
/** Mirrors MAX_MUTE_ATTEMPTS in the module under test. */
const MAX_MUTE_ATTEMPTS = 5;

const alertSpy = Alert.alert as jest.Mock;

/** A promise whose settlement the test controls, for in-flight assertions. */
function deferred<T = undefined>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Drain the microtask queue without a timer. setImmediate is itself faked by
 * the D8 debounce tests, so `flush` cannot be used there.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function queueOp(
  targetId: string,
  op: Partial<PendingMuteOpDouble> & { muted: boolean },
): void {
  storeState.pendingMuteOps = {
    ...storeState.pendingMuteOps,
    [targetId]: {
      targetType: op.targetType ?? 'thread',
      muted: op.muted,
      ownerUserId: op.ownerUserId ?? 'user-1',
      attempts: op.attempts ?? 0,
    },
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Module-level runners/epoch/draining must not leak across tests.
  clearNotificationSyncState();
  unregisterForegroundNotificationSettingsSync();
  storeState.userId = 'user-1';
  storeState.isAuthenticated = true;
  storeState.notificationPrefs = {
    newThread: true,
    newReply: true,
    newDm: true,
    memberJoined: true,
  };
  storeState.mutedTargets = {};
  storeState.pendingMuteOps = {};
  mockGetNotificationPrefs.mockResolvedValue({
    newThread: true,
    newReply: true,
    newDm: true,
    memberJoined: true,
  });
  mockGetNotificationMutes.mockResolvedValue({ mutes: [] });
  mockUpdateNotificationPrefs.mockResolvedValue(undefined);
  mockMuteTargetApi.mockResolvedValue(undefined);
  mockUnmuteTargetApi.mockResolvedValue(undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// syncNotificationSettings
// ---------------------------------------------------------------------------

describe('syncNotificationSettings', () => {
  it('overwrites both halves from the server response', async () => {
    mockGetNotificationPrefs.mockResolvedValue({
      newThread: false,
      newReply: true,
      newDm: false,
      memberJoined: true,
    });
    mockGetNotificationMutes.mockResolvedValue({
      mutes: [
        { targetId: 'thread-1', targetType: 'thread', createdAt: '2026-08-03T00:00:00Z' },
        { targetId: 'group-9', targetType: 'group', createdAt: '2026-08-03T00:00:01Z' },
      ],
    });

    await syncNotificationSettings();

    expect(storeState.notificationPrefs).toEqual({
      newThread: false,
      newReply: true,
      newDm: false,
      memberJoined: true,
    });
    expect(storeState.mutedTargets).toEqual({
      'thread-1': 'thread',
      'group-9': 'group',
    });
  });

  it('replaces (not merges) the mute map — server-authoritative overwrite prunes orphans', async () => {
    storeState.mutedTargets = { 'stale-thread': 'thread' };
    mockGetNotificationMutes.mockResolvedValue({
      mutes: [
        { targetId: 'thread-2', targetType: 'thread', createdAt: '2026-08-03T00:00:00Z' },
      ],
    });

    await syncNotificationSettings();

    expect(storeState.mutedTargets).toEqual({ 'thread-2': 'thread' });
  });

  it('clears local mutes when the server reports none', async () => {
    storeState.mutedTargets = { 'thread-1': 'thread' };

    await syncNotificationSettings();

    expect(storeState.mutedTargets).toEqual({});
  });

  it('leaves prefs untouched when the prefs call rejects but still applies mutes', async () => {
    storeState.notificationPrefs = {
      newThread: false,
      newReply: true,
      newDm: true,
      memberJoined: true,
    };
    mockGetNotificationPrefs.mockRejectedValue(new NetworkError());
    mockGetNotificationMutes.mockResolvedValue({
      mutes: [
        { targetId: 'thread-3', targetType: 'thread', createdAt: '2026-08-03T00:00:00Z' },
      ],
    });

    await syncNotificationSettings();

    // The failed half is never reset to defaults.
    expect(storeState.notificationPrefs.newThread).toBe(false);
    expect(mockSetNotificationPrefs).not.toHaveBeenCalled();
    expect(storeState.mutedTargets).toEqual({ 'thread-3': 'thread' });
  });

  it('leaves mutes untouched when the mutes call rejects but still applies prefs', async () => {
    storeState.mutedTargets = { 'thread-1': 'thread' };
    mockGetNotificationPrefs.mockResolvedValue({
      newThread: false,
      newReply: false,
      newDm: false,
      memberJoined: false,
    });
    mockGetNotificationMutes.mockRejectedValue(new ServerError(500));

    await syncNotificationSettings();

    expect(mockSetMutedTargets).not.toHaveBeenCalled();
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(storeState.notificationPrefs.newReply).toBe(false);
  });

  it('does not throw when both halves reject', async () => {
    mockGetNotificationPrefs.mockRejectedValue(new NetworkError());
    mockGetNotificationMutes.mockRejectedValue(new NetworkError());

    await expect(syncNotificationSettings()).resolves.toBeUndefined();
    expect(mockSetNotificationPrefs).not.toHaveBeenCalled();
    expect(mockSetMutedTargets).not.toHaveBeenCalled();
  });

  it('ignores malformed pref keys and malformed mute rows', async () => {
    mockGetNotificationPrefs.mockResolvedValue({
      newThread: 'nope',
      newReply: false,
      bogusKey: true,
    });
    mockGetNotificationMutes.mockResolvedValue({
      mutes: [
        { targetId: 'thread-1', targetType: 'orbit', createdAt: 'x' },
        { targetId: '', targetType: 'thread', createdAt: 'x' },
        { targetId: 'group-1', targetType: 'group', createdAt: 'x' },
      ],
    });

    await syncNotificationSettings();

    expect(storeState.notificationPrefs).toEqual({
      newThread: true, // non-boolean ignored, previous value survives
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
    expect(storeState.mutedTargets).toEqual({ 'group-1': 'group' });
  });
});

// ---------------------------------------------------------------------------
// Sync vs. optimistic state (D3)
// ---------------------------------------------------------------------------

describe('syncNotificationSettings — drain-first + overlay', () => {
  it('drains the queue before issuing the GETs', async () => {
    const order: string[] = [];
    queueOp('thread-1', { muted: true });
    mockMuteTargetApi.mockImplementation(async () => {
      order.push('PUT');
    });
    mockGetNotificationMutes.mockImplementation(async () => {
      order.push('GET mutes');
      return { mutes: [] };
    });
    mockGetNotificationPrefs.mockImplementation(async () => {
      order.push('GET prefs');
      return {};
    });

    await syncNotificationSettings();

    expect(order[0]).toBe('PUT');
    expect(order).toContain('GET mutes');
  });

  it('overlays an in-flight optimistic mute on top of the server snapshot', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);
    const toggle = toggleMute('thread-1', 'thread');
    await flush();

    // Server has not seen the mute yet.
    await syncNotificationSettings();

    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    // The drain must not double-send while a runner owns the target.
    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);

    put.resolve(undefined);
    await toggle;
  });

  it('overlays a queued offline unmute so the server snapshot cannot re-mute it', async () => {
    storeState.mutedTargets = { 'thread-1': 'thread' };
    queueOp('thread-1', { muted: false });
    mockUnmuteTargetApi.mockRejectedValue(new NetworkError());
    mockGetNotificationMutes.mockResolvedValue({
      mutes: [{ targetId: 'thread-1', targetType: 'thread', createdAt: 'x' }],
    });

    await syncNotificationSettings();

    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps['thread-1']).toBeDefined();
  });

  it('never applies a mismatched-owner entry and deletes it from the queue', async () => {
    queueOp('thread-1', { muted: true, ownerUserId: 'user-A' });
    storeState.userId = 'user-B';
    mockGetNotificationMutes.mockResolvedValue({ mutes: [] });

    await syncNotificationSettings();

    expect(mockMuteTargetApi).not.toHaveBeenCalled();
    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps['thread-1']).toBeUndefined();
  });

  it('overlays an unconfirmed pref intent on top of the server snapshot', async () => {
    const put = deferred();
    mockUpdateNotificationPrefs.mockReturnValue(put.promise);
    const pref = setPref('newReply', false);
    await flush();

    mockGetNotificationPrefs.mockResolvedValue({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });

    await syncNotificationSettings();

    expect(storeState.notificationPrefs.newReply).toBe(false);

    put.resolve(undefined);
    await pref;
  });
});

// ---------------------------------------------------------------------------
// toggleMute
// ---------------------------------------------------------------------------

describe('toggleMute', () => {
  it('optimistically mutes then confirms via PUT', async () => {
    await toggleMute('thread-1', 'thread');

    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-1', 'thread');
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(storeState.pendingMuteOps).toEqual({});
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('optimistically unmutes an already-muted target then confirms via DELETE', async () => {
    storeState.mutedTargets = { 'group-9': 'group' };

    await toggleMute('group-9', 'group');

    expect(mockUnmuteTargetApi).toHaveBeenCalledWith('group-9');
    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('enqueues the intent before issuing the request (write-ahead)', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);

    const toggle = toggleMute('thread-1', 'thread');
    await flush();

    expect(storeState.pendingMuteOps['thread-1']).toEqual({
      targetType: 'thread',
      muted: true,
      ownerUserId: 'user-1',
      attempts: 0,
    });

    put.resolve(undefined);
    await toggle;
    expect(storeState.pendingMuteOps['thread-1']).toBeUndefined();
  });

  it('rolls the mute back and clears the entry on a 404', async () => {
    mockMuteTargetApi.mockRejectedValue(new NotFoundError());

    await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('restores the mute (with its original type) when the DELETE is terminal', async () => {
    storeState.mutedTargets = { 'group-9': 'group', 'thread-1': 'thread' };
    mockUnmuteTargetApi.mockRejectedValue(new NotFoundError());

    await toggleMute('group-9', 'group');

    expect(storeState.mutedTargets).toEqual({ 'group-9': 'group', 'thread-1': 'thread' });
  });

  it('retains the optimistic state and the queue entry when offline', async () => {
    mockMuteTargetApi.mockRejectedValue(new NetworkError());

    await toggleMute('thread-1', 'thread');

    // Pre-#678 this rolled back and the intent evaporated.
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(storeState.pendingMuteOps['thread-1']).toMatchObject({ muted: true });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('retains the optimistic state and the queue entry on a 5xx', async () => {
    mockMuteTargetApi.mockRejectedValue(new ServerError(503));

    await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(storeState.pendingMuteOps['thread-1']).toMatchObject({ muted: true });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('rolls back only the toggled target, leaving other mutes intact', async () => {
    storeState.mutedTargets = { 'thread-other': 'thread' };
    mockMuteTargetApi.mockRejectedValue(new ValidationError(400));

    await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({ 'thread-other': 'thread' });
  });
});

// ---------------------------------------------------------------------------
// Mute concurrency (D1)
// ---------------------------------------------------------------------------

describe('toggleMute — coalescing runner', () => {
  it('serialises a change of mind: PUT completes before the DELETE is issued', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);
    let deleteIssuedWhilePutInFlight = false;
    let putSettled = false;
    mockUnmuteTargetApi.mockImplementation(async () => {
      if (!putSettled) deleteIssuedWhilePutInFlight = true;
    });

    const first = toggleMute('thread-1', 'thread');
    await flush();
    const second = toggleMute('thread-1', 'thread');
    await flush();

    // The second tap never issues its own request.
    expect(mockUnmuteTargetApi).not.toHaveBeenCalled();
    await second;

    putSettled = true;
    put.resolve(undefined);
    await first;

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(mockUnmuteTargetApi).toHaveBeenCalledTimes(1);
    expect(deleteIssuedWhilePutInFlight).toBe(false);
    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('sends no follow-up when the intent returns to the value already in flight', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);

    const first = toggleMute('thread-1', 'thread'); // intent: muted
    await flush();
    await toggleMute('thread-1', 'thread'); // intent: unmuted
    await toggleMute('thread-1', 'thread'); // intent: muted again

    put.resolve(undefined);
    await first;

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(mockUnmuteTargetApi).not.toHaveBeenCalled();
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('a reentrant toggle resolves while the first request is still pending', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);

    const first = toggleMute('thread-1', 'thread');
    await flush();

    let secondSettled = false;
    await toggleMute('thread-1', 'thread').then(() => {
      secondSettled = true;
    });

    expect(secondSettled).toBe(true);
    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);

    put.resolve(undefined);
    await first;
  });

  it('runs different targets independently', async () => {
    await Promise.all([
      toggleMute('thread-1', 'thread'),
      toggleMute('group-9', 'group'),
    ]);

    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-1', 'thread');
    expect(mockMuteTargetApi).toHaveBeenCalledWith('group-9', 'group');
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread', 'group-9': 'group' });
  });

  it('at MAX_PENDING_MUTE_OPS a new target still issues its request, unqueued', async () => {
    const filled: Record<string, PendingMuteOpDouble> = {};
    for (let i = 0; i < MAX_PENDING_MUTE_OPS; i++) {
      filled[`filler-${i}`] = {
        targetType: 'thread',
        muted: true,
        ownerUserId: 'user-1',
        attempts: 0,
      };
    }
    storeState.pendingMuteOps = filled;

    await toggleMute('thread-new', 'thread');

    // Seeded runner: the tap behaves like today's code, it just does not
    // survive a restart.
    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-new', 'thread');
    expect(storeState.mutedTargets['thread-new']).toBe('thread');
    expect(storeState.pendingMuteOps['thread-new']).toBeUndefined();
    expect(Object.keys(storeState.pendingMuteOps)).toHaveLength(MAX_PENDING_MUTE_OPS);
  });
});

// ---------------------------------------------------------------------------
// Replay queue (D4/D5)
// ---------------------------------------------------------------------------

describe('drainPendingMuteOps', () => {
  it('replays a queued mute and clears the entry on success', async () => {
    queueOp('thread-1', { muted: true });

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-1', 'thread');
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('replays a queued unmute via DELETE', async () => {
    queueOp('group-9', { muted: false, targetType: 'group' });

    await drainPendingMuteOps();

    expect(mockUnmuteTargetApi).toHaveBeenCalledWith('group-9');
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('stops at the first retryable failure and leaves the remaining entries queued', async () => {
    queueOp('thread-1', { muted: true });
    queueOp('thread-2', { muted: true });
    mockMuteTargetApi.mockRejectedValueOnce(new NetworkError());

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(storeState.pendingMuteOps['thread-1']).toMatchObject({ attempts: 1 });
    expect(storeState.pendingMuteOps['thread-2']).toMatchObject({ attempts: 0 });
  });

  it('rolls back and clears on a 404 without alerting', async () => {
    storeState.mutedTargets = { 'thread-1': 'thread' };
    queueOp('thread-1', { muted: true });
    mockMuteTargetApi.mockRejectedValue(new NotFoundError());

    await drainPendingMuteOps();

    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps).toEqual({});
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('never alerts, even for an otherwise alert-worthy failure', async () => {
    queueOp('thread-1', { muted: true });
    mockMuteTargetApi.mockRejectedValue(new ValidationError(400));

    await drainPendingMuteOps();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('skips targets that a live interactive runner owns', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);
    const toggle = toggleMute('thread-1', 'thread');
    await flush();

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    put.resolve(undefined);
    await toggle;
  });

  it('skips and deletes entries whose ownerUserId is not the current user', async () => {
    queueOp('thread-A', { muted: true, ownerUserId: 'user-A' });
    queueOp('thread-B', { muted: true, ownerUserId: 'user-1' });

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-B', 'thread');
    expect(storeState.pendingMuteOps).toEqual({});
  });

  it('retains the entry and stops on a 401, without bumping attempts', async () => {
    queueOp('thread-1', { muted: true });
    queueOp('thread-2', { muted: true });
    mockMuteTargetApi.mockRejectedValue(new AuthError(401));
    storeState.mutedTargets = { 'thread-1': 'thread', 'thread-2': 'thread' };

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(storeState.pendingMuteOps['thread-1']).toMatchObject({ attempts: 0 });
    expect(storeState.pendingMuteOps['thread-2']).toMatchObject({ attempts: 0 });
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread', 'thread-2': 'thread' });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('abandons an entry after MAX_MUTE_ATTEMPTS failed drains and breadcrumbs once', async () => {
    storeState.mutedTargets = { 'thread-1': 'thread' };
    queueOp('thread-1', { muted: true, attempts: MAX_MUTE_ATTEMPTS - 1 });
    mockMuteTargetApi.mockRejectedValue(new NetworkError());

    await drainPendingMuteOps();

    // Reverted to server truth so the overlay stops pinning an unaccepted intent.
    expect(storeState.mutedTargets).toEqual({});
    expect(storeState.pendingMuteOps).toEqual({});
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledTimes(1);
    const breadcrumb = mockSentryAddBreadcrumb.mock.calls[0][0];
    expect(breadcrumb.data).toEqual({ attempts: MAX_MUTE_ATTEMPTS, error: 'NetworkError' });
    // Log hygiene: no target ids in the breadcrumb.
    expect(JSON.stringify(breadcrumb)).not.toContain('thread-1');
  });

  it('does not abandon before the attempt bound is reached', async () => {
    queueOp('thread-1', { muted: true, attempts: MAX_MUTE_ATTEMPTS - 2 });
    mockMuteTargetApi.mockRejectedValue(new NetworkError());

    await drainPendingMuteOps();

    expect(storeState.pendingMuteOps['thread-1']).toMatchObject({
      attempts: MAX_MUTE_ATTEMPTS - 1,
    });
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('is single-flight — a concurrent call does not double-send', async () => {
    const put = deferred();
    queueOp('thread-1', { muted: true });
    mockMuteTargetApi.mockReturnValue(put.promise);

    const first = drainPendingMuteOps();
    await flush();
    const second = drainPendingMuteOps();

    put.resolve(undefined);
    await Promise.all([first, second]);

    // The rerun pass finds an empty queue.
    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    queueOp('thread-1', { muted: true });
    mockMuteTargetApi.mockRejectedValue(new Error('boom'));

    await expect(drainPendingMuteOps()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setPref
// ---------------------------------------------------------------------------

describe('setPref', () => {
  it('optimistically flips the key and PUTs only that key', async () => {
    await setPref('newReply', false);

    expect(mockUpdateNotificationPrefs).toHaveBeenCalledWith({ newReply: false });
    expect(storeState.notificationPrefs.newReply).toBe(false);
    expect(storeState.notificationPrefs.newThread).toBe(true);
  });

  it('applies ONLY the toggled key from the response body', async () => {
    mockUpdateNotificationPrefs.mockResolvedValue({
      newThread: false,
      newReply: false,
      newDm: false,
      memberJoined: false,
    });

    await setPref('newReply', false);

    // Pre-#678 the whole response body was applied, so a slow response for one
    // key visibly reverted a fast one for another.
    expect(storeState.notificationPrefs).toEqual({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
  });

  it('out-of-order responses for different keys do not revert each other', async () => {
    const threadPut = deferred<Record<string, boolean>>();
    const replyPut = deferred<Record<string, boolean>>();
    mockUpdateNotificationPrefs.mockImplementation((patch: Record<string, boolean>) =>
      'newThread' in patch ? threadPut.promise : replyPut.promise,
    );

    const threadCall = setPref('newThread', false);
    const replyCall = setPref('newReply', false);
    await flush();

    // The second request answers first, carrying a stale newThread.
    replyPut.resolve({ newThread: true, newReply: false, newDm: true, memberJoined: true });
    await replyCall;
    expect(storeState.notificationPrefs.newThread).toBe(false);

    threadPut.resolve({ newThread: false, newReply: true, newDm: true, memberJoined: true });
    await threadCall;
    expect(storeState.notificationPrefs.newReply).toBe(false);
    expect(storeState.notificationPrefs.newThread).toBe(false);
  });

  it('coalesces repeated toggles of one key to the final value', async () => {
    const firstPut = deferred<Record<string, boolean>>();
    mockUpdateNotificationPrefs.mockReturnValueOnce(firstPut.promise);
    mockUpdateNotificationPrefs.mockResolvedValue({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });

    const driving = setPref('newThread', false);
    await flush();
    await setPref('newThread', true);

    firstPut.resolve({ newThread: false, newReply: true, newDm: true, memberJoined: true });
    await driving;

    expect(mockUpdateNotificationPrefs).toHaveBeenNthCalledWith(1, { newThread: false });
    expect(mockUpdateNotificationPrefs).toHaveBeenNthCalledWith(2, { newThread: true });
    expect(storeState.notificationPrefs.newThread).toBe(true);
  });

  it('rolls back only that key when the PUT rejects', async () => {
    storeState.notificationPrefs.newDm = false;
    mockUpdateNotificationPrefs.mockRejectedValue(new ValidationError(400));

    await setPref('newReply', false);

    expect(storeState.notificationPrefs.newReply).toBe(true);
    // Unrelated keys are untouched by the rollback.
    expect(storeState.notificationPrefs.newDm).toBe(false);
    expect(alertSpy).toHaveBeenCalled();
  });

  it('rolls back silently when offline (no pref replay queue by design)', async () => {
    mockUpdateNotificationPrefs.mockRejectedValue(new NetworkError());

    await setPref('memberJoined', false);

    expect(storeState.notificationPrefs.memberJoined).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the value already matches', async () => {
    await setPref('newThread', true);

    expect(mockUpdateNotificationPrefs).not.toHaveBeenCalled();
    expect(mockSetNotificationPrefs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Alert copy (D6)
// ---------------------------------------------------------------------------

describe('alert copy', () => {
  it('never alerts on a 404 mute', async () => {
    mockMuteTargetApi.mockRejectedValue(new NotFoundError());

    await toggleMute('thread-1', 'thread');

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('never alerts on a 401 mute', async () => {
    mockMuteTargetApi.mockRejectedValue(new AuthError(401));

    await toggleMute('thread-1', 'thread');

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('alerts the module constant on an unexpected mute failure, never the error message', async () => {
    mockMuteTargetApi.mockRejectedValue(new ValidationError(400));

    await toggleMute('thread-1', 'thread');

    expect(alertSpy).toHaveBeenCalledWith('Notification settings', MUTE_FAILED_COPY);
    expect(alertSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Invalid request'),
    );
  });

  it('never surfaces a classifier string from an unmapped ApiError', async () => {
    mockMuteTargetApi.mockRejectedValue(new ApiError('Not found', 409, 'CONFLICT', false));

    await toggleMute('thread-1', 'thread');

    expect(alertSpy).toHaveBeenCalledWith('Notification settings', MUTE_FAILED_COPY);
    expect(alertSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Not found'),
    );
    expect(alertSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Authentication required'),
    );
  });

  it('alerts the pref constant on an unexpected pref failure', async () => {
    mockUpdateNotificationPrefs.mockRejectedValue(new ValidationError(422));

    await setPref('newReply', false);

    expect(alertSpy).toHaveBeenCalledWith('Notification settings', PREF_FAILED_COPY);
  });

  it('never alerts on a 404 or 401 pref failure', async () => {
    mockUpdateNotificationPrefs.mockRejectedValue(new NotFoundError());
    await setPref('newReply', false);

    mockUpdateNotificationPrefs.mockRejectedValue(new AuthError(401));
    await setPref('newDm', false);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(storeState.notificationPrefs.newReply).toBe(true);
    expect(storeState.notificationPrefs.newDm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (D7)
// ---------------------------------------------------------------------------

describe('clearNotificationSyncState', () => {
  it('drops a rollback that lands after the wipe', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);
    const toggle = toggleMute('thread-1', 'thread');
    await flush();

    clearNotificationSyncState();
    mockRemoveMutedTarget.mockClear();
    mockAddMutedTarget.mockClear();

    put.reject(new ValidationError(400));
    await toggle;

    expect(mockRemoveMutedTarget).not.toHaveBeenCalled();
    expect(mockAddMutedTarget).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('drops a confirmation that lands after the wipe', async () => {
    const put = deferred();
    mockMuteTargetApi.mockReturnValue(put.promise);
    const toggle = toggleMute('thread-1', 'thread');
    await flush();

    clearNotificationSyncState();
    mockClearPendingMuteOp.mockClear();

    put.resolve(undefined);
    await toggle;

    expect(mockClearPendingMuteOp).not.toHaveBeenCalled();
  });

  it('aborts the drain — no further requests after an epoch bump mid-loop', async () => {
    queueOp('thread-1', { muted: true });
    queueOp('thread-2', { muted: true });
    mockMuteTargetApi.mockImplementationOnce(async () => {
      clearNotificationSyncState();
    });

    await drainPendingMuteOps();

    expect(mockMuteTargetApi).toHaveBeenCalledTimes(1);
    expect(mockClearPendingMuteOps).not.toHaveBeenCalled();
  });

  it('drops an in-flight pref confirmation after the wipe', async () => {
    const put = deferred<Record<string, boolean>>();
    mockUpdateNotificationPrefs.mockReturnValue(put.promise);
    const pref = setPref('newReply', false);
    await flush();

    clearNotificationSyncState();
    mockSetNotificationPrefs.mockClear();

    put.resolve({ newThread: true, newReply: true, newDm: true, memberJoined: true });
    await pref;

    expect(mockSetNotificationPrefs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Foreground sync (D8)
// ---------------------------------------------------------------------------

describe('foreground notification-settings sync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers an AppState listener', () => {
    registerForegroundNotificationSettingsSync();

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('is idempotent', () => {
    registerForegroundNotificationSettingsSync();
    registerForegroundNotificationSettingsSync();

    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('unregisters the listener', () => {
    const remove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValueOnce({ remove });

    registerForegroundNotificationSettingsSync();
    unregisterForegroundNotificationSettingsSync();

    expect(remove).toHaveBeenCalled();
  });

  it('schedules a debounced sync on a foreground transition', async () => {
    let handler: ((state: string) => void) | undefined;
    (AppState.addEventListener as jest.Mock).mockImplementationOnce(
      (_event: string, cb: (state: string) => void) => {
        handler = cb;
        return { remove: jest.fn() };
      },
    );
    registerForegroundNotificationSettingsSync();

    handler?.('active');
    expect(mockGetNotificationPrefs).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(mockGetNotificationPrefs).toHaveBeenCalled();
  });

  it('ignores non-active AppState transitions', async () => {
    let handler: ((state: string) => void) | undefined;
    (AppState.addEventListener as jest.Mock).mockImplementationOnce(
      (_event: string, cb: (state: string) => void) => {
        handler = cb;
        return { remove: jest.fn() };
      },
    );
    registerForegroundNotificationSettingsSync();

    handler?.('background');
    await jest.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(mockGetNotificationPrefs).not.toHaveBeenCalled();
  });

  it('skips the sync while unauthenticated', async () => {
    storeState.isAuthenticated = false;

    scheduleNotificationSettingsSync();
    await jest.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(mockGetNotificationPrefs).not.toHaveBeenCalled();
    expect(mockGetNotificationMutes).not.toHaveBeenCalled();
  });

  it('collapses repeated schedules into one trailing run', async () => {
    scheduleNotificationSettingsSync();
    await jest.advanceTimersByTimeAsync(1_000);
    scheduleNotificationSettingsSync();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockGetNotificationPrefs).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(mockGetNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('clearNotificationSyncState cancels a pending schedule', async () => {
    scheduleNotificationSettingsSync();
    clearNotificationSyncState();
    await jest.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(mockGetNotificationPrefs).not.toHaveBeenCalled();
  });
});
