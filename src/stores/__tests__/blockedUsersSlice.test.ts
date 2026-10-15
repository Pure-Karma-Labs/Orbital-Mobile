/**
 * Tests for blockedUsersSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createBlockedUsersSlice } from '../slices/blockedUsersSlice';
import { NetworkError } from '../../services/api/errors';
import type { AppState } from '../../types/store';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockBlockUserApi = jest.fn().mockResolvedValue(undefined);
const mockUnblockUserApi = jest.fn().mockResolvedValue(undefined);
const mockGetBlockedUsers = jest.fn().mockResolvedValue({ blockedUserIds: [] });

const mockCaptureError = jest.fn();

jest.mock('../../services/api/users', () => ({
  blockUserApi: (...args: unknown[]) => mockBlockUserApi(...args),
  unblockUserApi: (...args: unknown[]) => mockUnblockUserApi(...args),
  getBlockedUsers: (...args: unknown[]) => mockGetBlockedUsers(...args),
}));

jest.mock('../../services/telemetry', () => ({
  captureError: (...args: unknown[]) => mockCaptureError(...args),
}));

/** Let the fire-and-forget API promise settle and its catch handler run. */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createBlockedUsersSlice(...a),

    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    avatarPath: null,
    avatarDigest: null,
    needsTermsAcceptance: false,
    identityKeyConflict: false,
    keyRecoveryInProgress: false,
    email: null,
    conflictSource: null,
    keyRecoveryError: null,
    identityRestoreDeferred: false,
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),
    updateProfile: jest.fn(),
    setNeedsTermsAcceptance: jest.fn(),
    setIdentityKeyConflict: jest.fn(),
    setKeyRecoveryInProgress: jest.fn(),
    setEmail: jest.fn(),
    setConflictSource: jest.fn(),
    setKeyRecoveryError: jest.fn(),
    setIdentityRestoreDeferred: jest.fn(),

    conversations: {},
    conversationIds: [],
    activeConversationId: null,
    viewingConversationId: null,
    setConversations: jest.fn(),
    setGroupConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    incrementUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
    setViewingConversation: jest.fn(),
    bumpLastMessageAt: jest.fn(),

    threads: {},
    threadIdsByConversation: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    threadLastViewedAt: {},
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: jest.fn(),
    setReplies: jest.fn(),
    appendReplies: jest.fn(),
    upsertReply: jest.fn(),
    replaceReply: jest.fn(),
    reconcileReplies: jest.fn(() => []),
    removeReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
    markThreadViewed: jest.fn(),

    contacts: {},
    setContacts: jest.fn(),
    mergeContacts: jest.fn(),
    upsertContact: jest.fn(),
    removeContact: jest.fn(),
    setContactVerifiedStatus: jest.fn(),

    colorScheme: 'system' as const,
    activeTab: 'threads' as const,
    composerDraft: null,
    isComposerOpen: false,
    syncOverallStatus: 'synced' as const,
    soundEnabled: true,
    setColorScheme: jest.fn(),
    setActiveTab: jest.fn(),
    setComposerDraft: jest.fn(),
    toggleComposer: jest.fn(),
    setSyncStatus: jest.fn(),
    setSoundEnabled: jest.fn(),

    connectionStatus: 'disconnected' as const,
    lastConnectedAt: null,
    reconnectAttempt: 0,
    typingUsers: {},
    setConnectionStatus: jest.fn(),
    setLastConnectedAt: jest.fn(),
    setReconnectAttempt: jest.fn(),
    addTypingUser: jest.fn(),
    removeTypingUser: jest.fn(),
    clearTypingUsers: jest.fn(),

    media: {},
    mediaIdsByThread: {},
    mediaIdsByReply: {},
    mergeMediaForThread: jest.fn(),
    mergeMediaForReply: jest.fn(),
    mergeMediaBatch: jest.fn(),
    upsertMedia: jest.fn(),
    setMediaBatch: jest.fn(),
    updateMediaDownloadState: jest.fn(),
    updateMediaUploadState: jest.fn(),
    removeMedia: jest.fn(),

    pushPermissionGranted: false,
    pushToken: null,
    pushOptOut: false,
    notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
    mutedTargets: {},
    pendingMuteOps: {},
    setPushPermission: jest.fn(),
    setPushToken: jest.fn(),
    setPushOptOut: jest.fn(),
    setNotificationPrefs: jest.fn(),
    setMutedTargets: jest.fn(),
    addMutedTarget: jest.fn(),
    removeMutedTarget: jest.fn(),
    applyMuteIntent: jest.fn(),
    clearPendingMuteOp: jest.fn(),
    clearPendingMuteOps: jest.fn(),
    bumpPendingMuteAttempts: jest.fn(),
    resetNotificationSettings: jest.fn(),

    reportTarget: null,
    openReportSheet: jest.fn(),
    closeReportSheet: jest.fn(),
  })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockUnblockUserApi.mockResolvedValue(undefined);
  // The API-failure paths warn under __DEV__; keep the suite output quiet.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('blockedUsersSlice - initial state', () => {
  it('starts with empty blocked users', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.blockedUserIds).toEqual([]);
    expect(state.blockedUserProfiles).toEqual({});
  });
});

describe('blockedUsersSlice - blockUser', () => {
  it('adds a user to the blocked list', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
  });

  it('is idempotent — blocking same user twice does not duplicate', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().blockUser('user-1', 'alice');
    expect(store.getState().blockedUserIds).toEqual(['user-1']);
  });

  it('blocks multiple users', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().blockUser('user-2', 'bob');
    const state = store.getState();
    expect(state.blockedUserIds).toHaveLength(2);
    expect(state.blockedUserIds).toContain('user-1');
    expect(state.blockedUserIds).toContain('user-2');
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
    expect(state.blockedUserProfiles['user-2']).toBe('bob');
  });
});

describe('blockedUsersSlice - unblockUser', () => {
  it('removes a user from the blocked list', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().unblockUser('user-1');
    const state = store.getState();
    expect(state.blockedUserIds).toEqual([]);
    expect(state.blockedUserProfiles['user-1']).toBeUndefined();
  });

  it('is a no-op for unknown user ID', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().unblockUser('user-999');
    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
  });

  it('only removes the targeted user', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().blockUser('user-2', 'bob');
    store.getState().unblockUser('user-1');
    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-2']);
    expect(state.blockedUserProfiles['user-1']).toBeUndefined();
    expect(state.blockedUserProfiles['user-2']).toBe('bob');
  });
});

describe('blockedUsersSlice - resetBlockedUsers', () => {
  it('clears all blocked users', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().blockUser('user-2', 'bob');
    store.getState().resetBlockedUsers();
    const state = store.getState();
    expect(state.blockedUserIds).toEqual([]);
    expect(state.blockedUserProfiles).toEqual({});
  });

  it('is a no-op when already empty', () => {
    const store = makeStore();
    expect(() => store.getState().resetBlockedUsers()).not.toThrow();
    expect(store.getState().blockedUserIds).toEqual([]);
  });
});

describe('blockedUsersSlice - blockUser API wiring', () => {
  it('calls blockUserApi after updating state', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    expect(store.getState().blockedUserIds).toEqual(['user-1']);
    expect(mockBlockUserApi).toHaveBeenCalledWith('user-1');
  });

  it('does not call blockUserApi when user is already blocked', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    mockBlockUserApi.mockClear();
    store.getState().blockUser('user-1', 'alice');
    expect(mockBlockUserApi).not.toHaveBeenCalled();
  });
});

describe('blockedUsersSlice - unblockUser API wiring', () => {
  it('calls unblockUserApi after updating state', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    mockUnblockUserApi.mockClear();
    store.getState().unblockUser('user-1');
    expect(store.getState().blockedUserIds).toEqual([]);
    expect(mockUnblockUserApi).toHaveBeenCalledWith('user-1');
  });

  it('does not call unblockUserApi for unknown user', () => {
    const store = makeStore();
    store.getState().unblockUser('user-999');
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });
});

describe('blockedUsersSlice - unblockUser rollback (#896)', () => {
  it('restores the id and username when unblockUserApi rejects', async () => {
    const store = makeStore();
    store.setState({ userId: 'self' });
    store.getState().blockUser('user-1', 'alice');
    const failure = new Error('offline');
    mockUnblockUserApi.mockRejectedValueOnce(failure);

    store.getState().unblockUser('user-1');
    // Optimistic removal is visible immediately.
    expect(store.getState().blockedUserIds).toEqual([]);

    await flushMicrotasks();

    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
    expect(mockCaptureError).toHaveBeenCalledWith(failure, {
      tags: { feature: 'blocking', op: 'unblock' },
    });
  });

  it('does not roll back into another account after a session change', async () => {
    const store = makeStore();
    store.setState({ userId: 'self' });
    store.getState().blockUser('user-1', 'alice');
    mockUnblockUserApi.mockRejectedValueOnce(new Error('offline'));

    store.getState().unblockUser('user-1');
    // Logout + login as another account before the rejection lands.
    store.setState({ userId: 'other', blockedUserIds: [], blockedUserProfiles: {} });

    await flushMicrotasks();

    const state = store.getState();
    expect(state.blockedUserIds).toEqual([]);
    expect(state.blockedUserProfiles).toEqual({});
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('rolls back without a Sentry event when the failure is a NetworkError', async () => {
    const store = makeStore();
    store.setState({ userId: 'self' });
    store.getState().blockUser('user-1', 'alice');
    mockUnblockUserApi.mockRejectedValueOnce(new NetworkError());

    store.getState().unblockUser('user-1');
    await flushMicrotasks();

    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
    // Offline is a modelled transient state the rollback handles, not a fault.
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('does not duplicate the id when it was re-blocked before the rejection', async () => {
    const store = makeStore();
    store.setState({ userId: 'self' });
    store.getState().blockUser('user-1', 'alice');
    mockUnblockUserApi.mockRejectedValueOnce(new Error('offline'));

    store.getState().unblockUser('user-1');
    store.getState().blockUser('user-1', 'alice');

    await flushMicrotasks();

    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });
});

describe('blockedUsersSlice - hydrateBlockedUsers', () => {
  it('merges new IDs from server without duplicating existing ones', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().hydrateBlockedUsers(['user-1', 'user-2', 'user-3']);
    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1', 'user-2', 'user-3']);
    expect(state.blockedUserProfiles['user-1']).toBe('alice');
    // #896: hydrate writes ids only — no placeholder username is invented.
    expect('user-2' in state.blockedUserProfiles).toBe(false);
    expect('user-3' in state.blockedUserProfiles).toBe(false);
  });

  it('is a no-op when all server IDs are already present locally', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().blockUser('user-2', 'bob');
    const stateBefore = store.getState();
    store.getState().hydrateBlockedUsers(['user-1', 'user-2']);
    const stateAfter = store.getState();
    // State reference should not change on no-op (no set() called)
    expect(stateAfter.blockedUserIds).toBe(stateBefore.blockedUserIds);
  });

  it('handles hydration from empty local state', () => {
    const store = makeStore();
    store.getState().hydrateBlockedUsers(['user-1', 'user-2']);
    const state = store.getState();
    expect(state.blockedUserIds).toEqual(['user-1', 'user-2']);
    // #896: ids only — the screen renders a user-<id prefix> fallback label.
    expect(state.blockedUserProfiles).toEqual({});
  });

  it('handles empty server list as no-op', () => {
    const store = makeStore();
    store.getState().blockUser('user-1', 'alice');
    store.getState().hydrateBlockedUsers([]);
    expect(store.getState().blockedUserIds).toEqual(['user-1']);
  });
});
