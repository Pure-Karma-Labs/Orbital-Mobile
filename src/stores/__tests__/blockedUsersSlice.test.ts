/**
 * Tests for blockedUsersSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createBlockedUsersSlice } from '../slices/blockedUsersSlice';
import type { AppState } from '../../types/store';

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
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),
    updateProfile: jest.fn(),

    conversations: {},
    conversationIds: [],
    activeConversationId: null,
    viewingConversationId: null,
    setConversations: jest.fn(),
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
    setMediaForThread: jest.fn(),
    setMediaForReply: jest.fn(),
    upsertMedia: jest.fn(),
    setMediaBatch: jest.fn(),
    updateMediaDownloadState: jest.fn(),
    updateMediaUploadState: jest.fn(),
    removeMedia: jest.fn(),

    pushPermissionGranted: false,
    pushToken: null,
    setPushPermission: jest.fn(),
    setPushToken: jest.fn(),
  })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
