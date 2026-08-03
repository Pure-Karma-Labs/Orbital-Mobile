/**
 * Tests for notificationSettingsSync (#449).
 *
 * Covers the server-authoritative overwrite sync (per-call 2xx gating,
 * one-fails-one-succeeds isolation) and the optimistic toggle/pref mutations
 * with per-key rollback.
 */

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

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
 * rather than call counts.
 */
const storeState: {
  notificationPrefs: Record<string, boolean>;
  mutedTargets: Record<string, string>;
} = {
  notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
  mutedTargets: {},
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

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      notificationPrefs: storeState.notificationPrefs,
      mutedTargets: storeState.mutedTargets,
      setNotificationPrefs: mockSetNotificationPrefs,
      setMutedTargets: mockSetMutedTargets,
      addMutedTarget: mockAddMutedTarget,
      removeMutedTarget: mockRemoveMutedTarget,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Alert } from 'react-native';
import {
  syncNotificationSettings,
  toggleMute,
  setPref,
} from '../notificationSettingsSync';
import { NetworkError, ServerError } from '../api/errors';

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  storeState.notificationPrefs = {
    newThread: true,
    newReply: true,
    newDm: true,
    memberJoined: true,
  };
  storeState.mutedTargets = {};
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
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
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
// toggleMute
// ---------------------------------------------------------------------------

describe('toggleMute', () => {
  it('optimistically mutes then confirms via PUT', async () => {
    const result = await toggleMute('thread-1', 'thread');

    expect(mockMuteTargetApi).toHaveBeenCalledWith('thread-1', 'thread');
    expect(storeState.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(result).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('optimistically unmutes an already-muted target then confirms via DELETE', async () => {
    storeState.mutedTargets = { 'group-9': 'group' };

    const result = await toggleMute('group-9', 'group');

    expect(mockUnmuteTargetApi).toHaveBeenCalledWith('group-9');
    expect(storeState.mutedTargets).toEqual({});
    expect(result).toBe(false);
  });

  it('rolls the mute back when the PUT rejects', async () => {
    mockMuteTargetApi.mockRejectedValue(new ServerError(500));

    const result = await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({});
    expect(result).toBe(false);
    expect(alertSpy).toHaveBeenCalled();
  });

  it('restores the mute (with its original type) when the DELETE rejects', async () => {
    storeState.mutedTargets = { 'group-9': 'group', 'thread-1': 'thread' };
    mockUnmuteTargetApi.mockRejectedValue(new ServerError(500));

    const result = await toggleMute('group-9', 'group');

    expect(storeState.mutedTargets).toEqual({ 'group-9': 'group', 'thread-1': 'thread' });
    expect(result).toBe(true);
  });

  it('suppresses the Alert for network failures (offline)', async () => {
    mockMuteTargetApi.mockRejectedValue(new NetworkError());

    await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({});
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('rolls back only the toggled target, leaving other mutes intact', async () => {
    storeState.mutedTargets = { 'thread-other': 'thread' };
    mockMuteTargetApi.mockRejectedValue(new ServerError(500));

    await toggleMute('thread-1', 'thread');

    expect(storeState.mutedTargets).toEqual({ 'thread-other': 'thread' });
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

  it('applies the full pref set from the PUT response body when present', async () => {
    mockUpdateNotificationPrefs.mockResolvedValue({
      newThread: false,
      newReply: false,
      newDm: true,
      memberJoined: false,
    });

    await setPref('newReply', false);

    expect(storeState.notificationPrefs).toEqual({
      newThread: false,
      newReply: false,
      newDm: true,
      memberJoined: false,
    });
  });

  it('rolls back only that key when the PUT rejects', async () => {
    storeState.notificationPrefs.newDm = false;
    mockUpdateNotificationPrefs.mockRejectedValue(new ServerError(500));

    await setPref('newReply', false);

    expect(storeState.notificationPrefs.newReply).toBe(true);
    // Unrelated keys are untouched by the rollback.
    expect(storeState.notificationPrefs.newDm).toBe(false);
    expect(alertSpy).toHaveBeenCalled();
  });

  it('suppresses the Alert for network failures (offline)', async () => {
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
