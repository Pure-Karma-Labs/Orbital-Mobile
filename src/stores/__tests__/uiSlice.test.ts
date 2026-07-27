/**
 * Tests for uiSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createUISlice } from '../slices/uiSlice';
import type { AppState, Draft } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createUISlice(...a),

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
    setPushPermission: jest.fn(),
    setPushToken: jest.fn(),

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

describe('uiSlice — initial state', () => {
  it('has correct defaults', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.colorScheme).toBe('system');
    expect(state.activeTab).toBe('threads');
    expect(state.composerDraft).toBeNull();
    expect(state.isComposerOpen).toBe(false);
    expect(state.syncOverallStatus).toBe('synced');
  });
});

describe('uiSlice — setColorScheme', () => {
  it('updates colorScheme', () => {
    const store = makeStore();
    store.getState().setColorScheme('dark');
    expect(store.getState().colorScheme).toBe('dark');
    store.getState().setColorScheme('light');
    expect(store.getState().colorScheme).toBe('light');
    store.getState().setColorScheme('system');
    expect(store.getState().colorScheme).toBe('system');
  });
});

describe('uiSlice — setActiveTab', () => {
  it('updates activeTab', () => {
    const store = makeStore();
    store.getState().setActiveTab('chats');
    expect(store.getState().activeTab).toBe('chats');
    store.getState().setActiveTab('settings');
    expect(store.getState().activeTab).toBe('settings');
    store.getState().setActiveTab('threads');
    expect(store.getState().activeTab).toBe('threads');
  });
});

describe('uiSlice — setComposerDraft', () => {
  it('sets and clears a draft', () => {
    const store = makeStore();
    const draft: Draft = {
      contextId: 'conv-1',
      contextType: 'conversation',
      body: 'Draft text',
      updatedAt: 1000,
    };
    store.getState().setComposerDraft(draft);
    expect(store.getState().composerDraft).toEqual(draft);
    store.getState().setComposerDraft(null);
    expect(store.getState().composerDraft).toBeNull();
  });
});

describe('uiSlice — toggleComposer', () => {
  it('toggles isComposerOpen', () => {
    const store = makeStore();
    expect(store.getState().isComposerOpen).toBe(false);
    store.getState().toggleComposer();
    expect(store.getState().isComposerOpen).toBe(true);
    store.getState().toggleComposer();
    expect(store.getState().isComposerOpen).toBe(false);
  });
});

describe('uiSlice — setSyncStatus', () => {
  it('updates syncOverallStatus', () => {
    const store = makeStore();
    store.getState().setSyncStatus('pending');
    expect(store.getState().syncOverallStatus).toBe('pending');
    store.getState().setSyncStatus('syncing');
    expect(store.getState().syncOverallStatus).toBe('syncing');
    store.getState().setSyncStatus('failed');
    expect(store.getState().syncOverallStatus).toBe('failed');
    store.getState().setSyncStatus('synced');
    expect(store.getState().syncOverallStatus).toBe('synced');
  });
});
