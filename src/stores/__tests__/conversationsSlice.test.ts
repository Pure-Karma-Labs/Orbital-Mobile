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
    threadListPaging: {},
    mergeThreads: jest.fn(() => 0),
    trimThreadsToHead: jest.fn(),
    cacheThreadEntities: jest.fn(),
    setThreadListPaging: jest.fn(),
    clearThreadListPaging: jest.fn(),

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
    removeMediaForAuthor: jest.fn(),
    removeMediaForAuthors: jest.fn(),

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

    blockedUserIds: [],
    blockedUserProfiles: {},
    blockedUsersGeneration: 0,
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

  // Was "treats null lastMessageAt as 0": that rule sank an import-only orbit
  // to the bottom of the list for ever, because the server reports
  // `last_message_at: null` for one by design (#927).
  it('falls back to createdAt for a null lastMessageAt', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: null, createdAt: 900 });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 500 });
    store.getState().setConversations([c1, c2]);
    expect(store.getState().conversationIds[0]).toBe('conv-1');
  });

  it('still sorts a null-lastMessageAt row below a newer conversation', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: null, createdAt: 900 });
    const c2 = makeConversation({ id: 'conv-2', lastMessageAt: 5000 });
    store.getState().setConversations([c1, c2]);
    expect(store.getState().conversationIds).toEqual(['conv-2', 'conv-1']);
  });
});

// ---------------------------------------------------------------------------
// #927 — import-only orbits, and the fallback that is SORT-ONLY
// ---------------------------------------------------------------------------

describe('conversationsSlice — recency fallback (#927)', () => {
  it('orders an import-only orbit by its join time, not by 1970', () => {
    const store = makeStore();
    // An orbit whose only content is an import: the server never moves
    // last_message_at for imported threads, so it serves null.
    const importOnly = makeConversation({
      id: 'orbit-import',
      lastMessageAt: null,
      createdAt: 4000,
    });
    const quiet = makeConversation({ id: 'orbit-quiet', lastMessageAt: 3000 });
    const older = makeConversation({ id: 'orbit-older', lastMessageAt: 1000 });

    store.getState().setGroupConversations([older, quiet, importOnly]);

    expect(store.getState().conversationIds).toEqual([
      'orbit-import',
      'orbit-quiet',
      'orbit-older',
    ]);
  });

  it('leaves the stored lastMessageAt null — the fallback places, it does not write', () => {
    const store = makeStore();
    const importOnly = makeConversation({
      id: 'orbit-import',
      lastMessageAt: null,
      createdAt: 4000,
    });

    store.getState().setGroupConversations([importOnly]);
    expect(store.getState().conversations['orbit-import'].lastMessageAt).toBeNull();

    store.getState().upsertConversation(importOnly);
    expect(store.getState().conversations['orbit-import'].lastMessageAt).toBeNull();
  });

  it('still lets a bump BELOW createdAt land on a null row', () => {
    // The row sorts by createdAt (4000) while the stored value is null, but
    // `bumpLastMessageAt` keeps its own `?? 0` comparison: a first real
    // message at 2000 is still the newest MESSAGE and must be recorded.
    const store = makeStore();
    store.getState().setGroupConversations([
      makeConversation({ id: 'orbit-import', lastMessageAt: null, createdAt: 4000 }),
    ]);

    store.getState().bumpLastMessageAt('orbit-import', 2000);

    expect(store.getState().conversations['orbit-import'].lastMessageAt).toBe(2000);
  });

  it('sorts a brand-new DM with a null lastMessageAt by its creation time', () => {
    const store = makeStore();
    const freshDm = makeConversation({
      id: 'dm-new',
      type: 'direct',
      lastMessageAt: null,
      createdAt: 9000,
    });
    const chattyDm = makeConversation({ id: 'dm-old', type: 'direct', lastMessageAt: 8000 });

    store.getState().setConversations([chattyDm, freshDm]);

    // Matches what ChatsListScreen has always shown for DMs.
    expect(store.getState().conversationIds).toEqual(['dm-new', 'dm-old']);
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

  // #883: lastMessageAt is persisted and drives the Chats order, so a
  // non-finite bump would latch the row — NaN defeats every later comparison
  // and Infinity pins it to the top forever.
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['zero', 0],
    ['negative', -1],
  ])('ignores a %s timestamp (#883)', (_label, timestamp) => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: 2000, updatedAt: 2000 });
    store.getState().setConversations([c1]);

    store.getState().bumpLastMessageAt('conv-1', timestamp);

    const unchanged = store.getState().conversations['conv-1'];
    expect(unchanged.lastMessageAt).toBe(2000);
    expect(unchanged.updatedAt).toBe(2000);
  });

  it('ignores a non-finite bump even when lastMessageAt is null (#883)', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: null });
    store.getState().setConversations([c1]);

    store.getState().bumpLastMessageAt('conv-1', NaN);

    expect(store.getState().conversations['conv-1'].lastMessageAt).toBeNull();
  });

  it('heals a NaN already stored by a pre-#883 build', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'conv-1', lastMessageAt: NaN });
    store.getState().setConversations([c1]);

    store.getState().bumpLastMessageAt('conv-1', 4000);

    expect(store.getState().conversations['conv-1'].lastMessageAt).toBe(4000);
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

// ---------------------------------------------------------------------------
// Group-key heal generations (#912)
// ---------------------------------------------------------------------------

describe('conversationsSlice — bumpGroupKeyGeneration', () => {
  it('starts empty', () => {
    expect(makeStore().getState().groupKeyGeneration).toEqual({});
  });

  it('counts deliveries per group, monotonically', () => {
    const store = makeStore();

    store.getState().bumpGroupKeyGeneration('g-1');
    expect(store.getState().groupKeyGeneration).toEqual({ 'g-1': 1 });

    store.getState().bumpGroupKeyGeneration('g-1');
    store.getState().bumpGroupKeyGeneration('g-1');
    // Monotonic is the whole contract: a screen compares this against the
    // value it last loaded at, so a reset or a decrement would make it miss a
    // delivery it was mounted for.
    expect(store.getState().groupKeyGeneration['g-1']).toBe(3);
  });

  it('keys by groupId — one group\'s delivery leaves the others alone', () => {
    const store = makeStore();

    store.getState().bumpGroupKeyGeneration('g-1');
    store.getState().bumpGroupKeyGeneration('g-2');
    store.getState().bumpGroupKeyGeneration('g-2');

    expect(store.getState().groupKeyGeneration).toEqual({ 'g-1': 1, 'g-2': 2 });
  });

  // A demoted member can be sitting on a push deep link whose conversation row
  // has not loaded, which is exactly the screen that must reload — so the
  // counter must not require a conversation to exist.
  it('needs no conversation row for the group', () => {
    const store = makeStore();

    store.getState().bumpGroupKeyGeneration('never-loaded');

    expect(store.getState().groupKeyGeneration['never-loaded']).toBe(1);
    expect(store.getState().conversations['never-loaded']).toBeUndefined();
    expect(store.getState().conversationIds).toEqual([]);
  });

  it('leaves the conversation map and order untouched', () => {
    const store = makeStore();
    const c1 = makeConversation({ id: 'g-1' });
    store.getState().setConversations([c1]);
    const before = store.getState().conversations;

    store.getState().bumpGroupKeyGeneration('g-1');

    expect(store.getState().conversations).toBe(before);
    expect(store.getState().conversationIds).toEqual(['g-1']);
  });
});

describe('conversationsSlice — clearGroupKeyGenerations', () => {
  it('drops every counter', () => {
    const store = makeStore();
    store.getState().bumpGroupKeyGeneration('g-1');
    store.getState().bumpGroupKeyGeneration('g-2');

    store.getState().clearGroupKeyGenerations();

    expect(store.getState().groupKeyGeneration).toEqual({});
  });

  // localWipe calls this unconditionally, and a fresh {} would re-render every
  // `useGroupKeyGeneration` subscriber for nothing.
  it('is identity-stable when already empty', () => {
    const store = makeStore();
    const before = store.getState().groupKeyGeneration;

    store.getState().clearGroupKeyGenerations();

    expect(store.getState().groupKeyGeneration).toBe(before);
  });

  it('is identity-stable when called twice', () => {
    const store = makeStore();
    store.getState().bumpGroupKeyGeneration('g-1');

    store.getState().clearGroupKeyGenerations();
    const cleared = store.getState().groupKeyGeneration;
    store.getState().clearGroupKeyGenerations();

    expect(store.getState().groupKeyGeneration).toBe(cleared);
  });

  it('counts from zero again after a clear', () => {
    const store = makeStore();
    store.getState().bumpGroupKeyGeneration('g-1');
    store.getState().clearGroupKeyGenerations();

    store.getState().bumpGroupKeyGeneration('g-1');

    expect(store.getState().groupKeyGeneration['g-1']).toBe(1);
  });
});
