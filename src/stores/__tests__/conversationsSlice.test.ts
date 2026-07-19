/**
 * Tests for conversationsSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createConversationsSlice } from '../slices/conversationsSlice';
import type { AppState, Conversation } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createConversationsSlice(...a),

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
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),
    updateProfile: jest.fn(),
    setNeedsTermsAcceptance: jest.fn(),
    setIdentityKeyConflict: jest.fn(),
    setKeyRecoveryInProgress: jest.fn(),
    setEmail: jest.fn(),
    setConflictSource: jest.fn(),

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
// Fixtures
// ---------------------------------------------------------------------------

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    type: 'group',
    name: 'Family Chat',
    memberCount: 4,
    active: true,
    muteUntil: null,
    lastMessageAt: 1000,
    unreadCount: 0,
    lastReadAt: null,
    createdAt: 900,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('conversationsSlice — initial state', () => {
  it('starts with empty conversations and null active', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.conversations).toEqual({});
    expect(state.conversationIds).toEqual([]);
    expect(state.activeConversationId).toBeNull();
  });
});

describe('conversationsSlice — setConversations', () => {
  it('populates conversations map and ordered IDs', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 1000 });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 2000 });
    store.getState().setConversations([c1, c2]);
    const state = store.getState();
    expect(Object.keys(state.conversations)).toHaveLength(2);
    expect(state.conversations['conv-1']).toEqual(c1);
    expect(state.conversations['conv-2']).toEqual(c2);
  });

  it('orders conversationIds by lastMessageAt descending', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 1000 });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 3000 });
    const c3 = makeConversation({ id: 'conv-3', lastMessageAt: 2000 });
    store.getState().setConversations([c1, c2, c3]);
    expect(store.getState().conversationIds).toEqual(['conv-2', 'conv-3', 'conv-1']);
  });

  it('treats null lastMessageAt as 0 in sort', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: null });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 500 });
    store.getState().setConversations([c1, c2]);
    expect(store.getState().conversationIds[0]).toBe('conv-2');
  });
});

describe('conversationsSlice — upsertConversation', () => {
  it('inserts a new conversation and re-sorts', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 1000 });
    store.getState().setConversations([c1]);
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 2000 });
    store.getState().upsertConversation(c2);
    expect(store.getState().conversationIds).toEqual(['conv-2', 'conv-1']);
  });

  it('updates an existing conversation in place', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', unreadCount: 0 });
    store.getState().setConversations([c1]);
    store.getState().upsertConversation({ ...c1, unreadCount: 5 });
    expect(store.getState().conversations['conv-1'].unreadCount).toBe(5);
  });
});

describe('conversationsSlice — removeConversation', () => {
  it('removes the conversation from map and IDs', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1' });
    const c2 = makeConversation({ id: 'conv-2' });
    store.getState().setConversations([c1, c2]);
    store.getState().removeConversation('conv-1');
    const state = store.getState();
    expect('conv-1' in state.conversations).toBe(false);
    expect(state.conversationIds).not.toContain('conv-1');
  });

  it('clears activeConversationId when the active conversation is removed', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1' });
    store.getState().setConversations([c1]);
    store.getState().setActiveConversation('conv-1');
    store.getState().removeConversation('conv-1');
    expect(store.getState().activeConversationId).toBeNull();
  });

  it('keeps activeConversationId when a different conversation is removed', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1' });
    const c2 = makeConversation({ id: 'conv-2' });
    store.getState().setConversations([c1, c2]);
    store.getState().setActiveConversation('conv-1');
    store.getState().removeConversation('conv-2');
    expect(store.getState().activeConversationId).toBe('conv-1');
  });
});

describe('conversationsSlice — setActiveConversation', () => {
  it('sets and clears active conversation', () => {
    const store = makeStore();
    store.getState().setActiveConversation('conv-1');
    expect(store.getState().activeConversationId).toBe('conv-1');
    store.getState().setActiveConversation(null);
    expect(store.getState().activeConversationId).toBeNull();
  });
});

describe('conversationsSlice — updateUnreadCount', () => {
  it('updates unread count for existing conversation', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', unreadCount: 0 });
    store.getState().setConversations([c1]);
    store.getState().updateUnreadCount('conv-1', 7);
    expect(store.getState().conversations['conv-1'].unreadCount).toBe(7);
  });

  it('is a no-op for unknown conversation', () => {
    const store = makeStore();
    // Should not throw
    expect(() =>
      store.getState().updateUnreadCount('nonexistent', 5),
    ).not.toThrow();
  });
});

describe('conversationsSlice — markConversationRead', () => {
  it('sets unread count to 0', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', unreadCount: 10 });
    store.getState().setConversations([c1]);
    store.getState().markConversationRead('conv-1');
    expect(store.getState().conversations['conv-1'].unreadCount).toBe(0);
  });
});

describe('conversationsSlice — bumpLastMessageAt', () => {
  it('updates lastMessageAt and updatedAt when timestamp is newer', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 1000, updatedAt: 1000 });
    store.getState().setConversations([c1]);
    store.getState().bumpLastMessageAt('conv-1', 2000);
    const updated = store.getState().conversations['conv-1'];
    expect(updated.lastMessageAt).toBe(2000);
    expect(updated.updatedAt).toBe(2000);
  });

  it('does not update when timestamp is older (monotonic guard)', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 3000, updatedAt: 3000 });
    store.getState().setConversations([c1]);
    store.getState().bumpLastMessageAt('conv-1', 1000);
    const unchanged = store.getState().conversations['conv-1'];
    expect(unchanged.lastMessageAt).toBe(3000);
    expect(unchanged.updatedAt).toBe(3000);
  });

  it('does not update when timestamp equals current (equal guard)', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 2000, updatedAt: 2000 });
    store.getState().setConversations([c1]);
    store.getState().bumpLastMessageAt('conv-1', 2000);
    expect(store.getState().conversations['conv-1'].lastMessageAt).toBe(2000);
  });

  it('is a no-op for unknown conversation', () => {
    const store = makeStore();
    expect(() =>
      store.getState().bumpLastMessageAt('nonexistent', 5000),
    ).not.toThrow();
    expect(store.getState().conversations).toEqual({});
  });

  it('re-sorts conversationIds after bump', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 3000 });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 1000 });
    store.getState().setConversations([c1, c2]);
    expect(store.getState().conversationIds).toEqual(['conv-1', 'conv-2']);
    store.getState().bumpLastMessageAt('conv-2', 5000);
    expect(store.getState().conversationIds).toEqual(['conv-2', 'conv-1']);
  });

  it('handles null lastMessageAt correctly', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: null });
    store.getState().setConversations([c1]);
    store.getState().bumpLastMessageAt('conv-1', 1000);
    expect(store.getState().conversations['conv-1'].lastMessageAt).toBe(1000);
  });
});

describe('conversationsSlice — incrementUnreadCount', () => {
  it('increments unread count by 1', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', unreadCount: 3 });
    store.getState().setConversations([c1]);
    store.getState().incrementUnreadCount('conv-1');
    expect(store.getState().conversations['conv-1'].unreadCount).toBe(4);
  });

  it('is a no-op for unknown conversation', () => {
    const store = makeStore();
    expect(() =>
      store.getState().incrementUnreadCount('nonexistent'),
    ).not.toThrow();
  });
});

describe('conversationsSlice — setViewingConversation', () => {
  it('sets and clears viewingConversationId', () => {
    const store = makeStore();
    expect(store.getState().viewingConversationId).toBeNull();
    store.getState().setViewingConversation('conv-1');
    expect(store.getState().viewingConversationId).toBe('conv-1');
    store.getState().setViewingConversation(null);
    expect(store.getState().viewingConversationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setGroupConversations — type-partitioned replace (#329 load-wipe regression)
// ---------------------------------------------------------------------------

describe('setGroupConversations', () => {
  it('preserves existing direct conversations and their unread counts (load-wipe regression)', () => {
    const store = makeStore();
    const dm = makeConversation({
      id: 'dm-1',
      type: 'direct',
      unreadCount: 5,
      lastMessageAt: 3000,
    });
    const oldGroup = makeConversation({ id: 'group-old', type: 'group' });
    store.getState().setConversations([dm, oldGroup]);

    const freshGroup = makeConversation({ id: 'group-new', type: 'group', lastMessageAt: 2000 });
    store.getState().setGroupConversations([freshGroup]);

    const state = store.getState();
    // DM survives untouched — this is the bug that hid all badges in the smoke test
    expect(state.conversations['dm-1']).toBeDefined();
    expect(state.conversations['dm-1'].unreadCount).toBe(5);
    // Group partition fully replaced: stale group gone, new group present
    expect(state.conversations['group-old']).toBeUndefined();
    expect(state.conversations['group-new']).toBeDefined();
  });

  it('removes group conversations absent from the server list (leaving an orbit)', () => {
    const store = makeStore();
    const g1 = makeConversation({ id: 'g-1', type: 'group' });
    const g2 = makeConversation({ id: 'g-2', type: 'group' });
    store.getState().setConversations([g1, g2]);

    store.getState().setGroupConversations([g1]);

    expect(store.getState().conversations['g-2']).toBeUndefined();
    expect(store.getState().conversationIds).toEqual(['g-1']);
  });

  it('sorts merged conversations by lastMessageAt descending', () => {
    const store = makeStore();
    const dm = makeConversation({ id: 'dm-1', type: 'direct', lastMessageAt: 1000 });
    store.getState().setConversations([dm]);

    const g = makeConversation({ id: 'g-1', type: 'group', lastMessageAt: 9000 });
    store.getState().setGroupConversations([g]);

    expect(store.getState().conversationIds).toEqual(['g-1', 'dm-1']);
  });
});
