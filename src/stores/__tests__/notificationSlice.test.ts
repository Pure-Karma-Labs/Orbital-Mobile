/**
 * Tests for notificationSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createNotificationSlice } from '../slices/notificationSlice';
import type { AppState } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createNotificationSlice(...a),

    // Auth stub
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

    // Conversations stub
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

    // Threads stub
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
    removeReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
    markThreadViewed: jest.fn(),

    // Contacts stub
    contacts: {},
    setContacts: jest.fn(),
    mergeContacts: jest.fn(),
    upsertContact: jest.fn(),
    removeContact: jest.fn(),
    setContactVerifiedStatus: jest.fn(),

    // UI stub
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

    // Connection stub
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

    // Media stub
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

    // BlockedUsers stub
    blockedUserIds: [],
    blockedUserProfiles: {},
    blockUser: jest.fn(),
    unblockUser: jest.fn(),
    resetBlockedUsers: jest.fn(),
    hydrateBlockedUsers: jest.fn(),

    reportTarget: null,
    openReportSheet: jest.fn(),
    closeReportSheet: jest.fn(),
  })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notificationSlice — initial state', () => {
  it('has correct defaults', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.pushPermissionGranted).toBe(false);
    expect(state.pushToken).toBeNull();
  });
});

describe('notificationSlice — setPushPermission', () => {
  it('updates pushPermissionGranted to true', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    expect(store.getState().pushPermissionGranted).toBe(true);
  });

  it('updates pushPermissionGranted to false', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    store.getState().setPushPermission(false);
    expect(store.getState().pushPermissionGranted).toBe(false);
  });
});

describe('notificationSlice — setPushToken', () => {
  it('stores a token', () => {
    const store = makeStore();
    store.getState().setPushToken('fcm-token-abc');
    expect(store.getState().pushToken).toBe('fcm-token-abc');
  });

  it('clears the token with null', () => {
    const store = makeStore();
    store.getState().setPushToken('fcm-token-abc');
    store.getState().setPushToken(null);
    expect(store.getState().pushToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #449: notification preferences + per-target mutes
// ---------------------------------------------------------------------------

describe('notificationSlice — notification settings defaults (#449)', () => {
  it('defaults every per-type preference to true', () => {
    const store = makeStore();
    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });
  });

  it('starts with no muted targets', () => {
    const store = makeStore();
    expect(store.getState().mutedTargets).toEqual({});
  });
});

describe('notificationSlice — setNotificationPrefs', () => {
  it('merges a partial patch, leaving other keys untouched', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({ newReply: false });

    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
  });

  it('applies a full overwrite (sync path)', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({
      newThread: false,
      newReply: false,
      newDm: false,
      memberJoined: false,
    });

    expect(Object.values(store.getState().notificationPrefs)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('does not mutate the previous prefs object', () => {
    const store = makeStore();
    const before = store.getState().notificationPrefs;
    store.getState().setNotificationPrefs({ newDm: false });

    expect(before.newDm).toBe(true);
    expect(store.getState().notificationPrefs).not.toBe(before);
  });
});

describe('notificationSlice — muted targets', () => {
  it('adds a thread mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');

    expect(store.getState().mutedTargets).toEqual({ 'thread-1': 'thread' });
  });

  it('adds a group mute alongside an existing thread mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');
    store.getState().addMutedTarget('group-9', 'group');

    expect(store.getState().mutedTargets).toEqual({
      'thread-1': 'thread',
      'group-9': 'group',
    });
  });

  it('removes a mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');
    store.getState().addMutedTarget('group-9', 'group');
    store.getState().removeMutedTarget('thread-1');

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
  });

  it('removing an unknown target is a no-op', () => {
    const store = makeStore();
    store.getState().addMutedTarget('group-9', 'group');
    const before = store.getState().mutedTargets;

    store.getState().removeMutedTarget('nope');

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
    expect(store.getState().mutedTargets).toBe(before);
  });

  it('setMutedTargets replaces the whole map (server-authoritative overwrite)', () => {
    const store = makeStore();
    store.getState().addMutedTarget('stale', 'thread');
    store.getState().setMutedTargets({ 'group-9': 'group' });

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
  });

  it('setMutedTargets copies the input (later external mutation does not leak in)', () => {
    const store = makeStore();
    const input: Record<string, 'thread' | 'group'> = { 'thread-1': 'thread' };
    store.getState().setMutedTargets(input);
    input['thread-2'] = 'thread';

    expect(store.getState().mutedTargets).toEqual({ 'thread-1': 'thread' });
  });
});

describe('notificationSlice — resetNotificationSettings', () => {
  it('restores all-true prefs and clears mutes', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({ newReply: false, newDm: false });
    store.getState().addMutedTarget('thread-1', 'thread');

    store.getState().resetNotificationSettings();

    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });
    expect(store.getState().mutedTargets).toEqual({});
  });

  it('leaves push permission/token state alone (device-scoped, not account-scoped)', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    store.getState().setPushToken('fcm-token-abc');

    store.getState().resetNotificationSettings();

    expect(store.getState().pushPermissionGranted).toBe(true);
    expect(store.getState().pushToken).toBe('fcm-token-abc');
  });
});
