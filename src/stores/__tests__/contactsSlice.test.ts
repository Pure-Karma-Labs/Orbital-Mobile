/**
 * Tests for contactsSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createContactsSlice } from '../slices/contactsSlice';
import type { AppState, Contact } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createContactsSlice(...a),

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

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
    conversationIds: ['conv-1'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contactsSlice — initial state', () => {
  it('starts with empty contacts map', () => {
    const store = makeStore();
    expect(store.getState().contacts).toEqual({});
  });
});

describe('contactsSlice — setContacts', () => {
  it('replaces the contacts map', () => {
    const store = makeStore();
    const c1 = makeContact({ id: 'contact-1' });
    const c2 = makeContact({ id: 'contact-2', displayName: 'Bob' });
    store.getState().setContacts([c1, c2]);
    const state = store.getState();
    expect(Object.keys(state.contacts)).toHaveLength(2);
    expect(state.contacts['contact-1']).toEqual(c1);
    expect(state.contacts['contact-2']).toEqual(c2);
  });

  it('replaces previous contacts on second call', () => {
    const store = makeStore();
    store.getState().setContacts([makeContact({ id: 'old-contact' })]);
    store.getState().setContacts([makeContact({ id: 'new-contact' })]);
    const state = store.getState();
    expect('old-contact' in state.contacts).toBe(false);
    expect('new-contact' in state.contacts).toBe(true);
  });
});

describe('contactsSlice — upsertContact', () => {
  it('inserts a new contact', () => {
    const store = makeStore();
    const c = makeContact({ id: 'contact-new' });
    store.getState().upsertContact(c);
    expect(store.getState().contacts['contact-new']).toEqual(c);
  });

  it('updates an existing contact', () => {
    const store = makeStore();
    const c = makeContact({ id: 'contact-1', displayName: 'Old Name' });
    store.getState().setContacts([c]);
    store.getState().upsertContact({ ...c, displayName: 'New Name' });
    expect(store.getState().contacts['contact-1'].displayName).toBe('New Name');
  });
});

describe('contactsSlice — removeContact', () => {
  it('removes the contact from the map', () => {
    const store = makeStore();
    const c = makeContact({ id: 'contact-1' });
    store.getState().setContacts([c]);
    store.getState().removeContact('contact-1');
    expect('contact-1' in store.getState().contacts).toBe(false);
  });

  it('is a no-op for unknown contact', () => {
    const store = makeStore();
    expect(() => store.getState().removeContact('nonexistent')).not.toThrow();
  });
});

describe('contactsSlice — mergeContacts', () => {
  it('inserts new contacts into an empty map', () => {
    const store = makeStore();
    const c1 = makeContact({ id: 'contact-1', username: 'alice' });
    const c2 = makeContact({ id: 'contact-2', username: 'bob', displayName: 'Bob' });
    store.getState().mergeContacts([c1, c2]);
    const state = store.getState();
    expect(Object.keys(state.contacts)).toHaveLength(2);
    expect(state.contacts['contact-1'].username).toBe('alice');
    expect(state.contacts['contact-2'].username).toBe('bob');
  });

  it('unions conversationIds without duplicates', () => {
    const store = makeStore();
    store.getState().setContacts([
      makeContact({ id: 'c1', conversationIds: ['conv-1', 'conv-2'] }),
    ]);
    store.getState().mergeContacts([
      makeContact({ id: 'c1', conversationIds: ['conv-2', 'conv-3'] }),
    ]);
    const ids = store.getState().contacts['c1'].conversationIds;
    expect(ids).toEqual(expect.arrayContaining(['conv-1', 'conv-2', 'conv-3']));
    expect(ids).toHaveLength(3);
  });

  it('preserves existing fields when incoming has null', () => {
    const store = makeStore();
    store.getState().setContacts([
      makeContact({ id: 'c1', username: 'alice', displayName: 'Alice', avatarPath: '/path.jpg' }),
    ]);
    store.getState().mergeContacts([
      makeContact({ id: 'c1', username: null, displayName: null, avatarPath: null }),
    ]);
    const contact = store.getState().contacts['c1'];
    expect(contact.username).toBe('alice');
    expect(contact.displayName).toBe('Alice');
    expect(contact.avatarPath).toBe('/path.jpg');
  });

  it('overwrites existing fields when incoming has non-null values', () => {
    const store = makeStore();
    store.getState().setContacts([
      makeContact({ id: 'c1', username: 'alice', displayName: 'Alice' }),
    ]);
    store.getState().mergeContacts([
      makeContact({ id: 'c1', username: 'alice_new', displayName: 'Alice Updated' }),
    ]);
    const contact = store.getState().contacts['c1'];
    expect(contact.username).toBe('alice_new');
    expect(contact.displayName).toBe('Alice Updated');
  });

  it('deduplicates by id when incoming contains duplicates', () => {
    const store = makeStore();
    store.getState().mergeContacts([
      makeContact({ id: 'c1', username: 'alice', conversationIds: ['conv-1'] }),
      makeContact({ id: 'c1', username: 'alice', conversationIds: ['conv-2'] }),
    ]);
    const contact = store.getState().contacts['c1'];
    expect(contact.conversationIds).toEqual(expect.arrayContaining(['conv-1', 'conv-2']));
  });

  it('does not affect contacts not in the incoming list', () => {
    const store = makeStore();
    store.getState().setContacts([
      makeContact({ id: 'c1', username: 'alice' }),
      makeContact({ id: 'c2', username: 'bob' }),
    ]);
    store.getState().mergeContacts([
      makeContact({ id: 'c1', username: 'alice_updated' }),
    ]);
    expect(store.getState().contacts['c2'].username).toBe('bob');
  });
});
