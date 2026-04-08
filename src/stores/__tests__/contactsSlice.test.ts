/**
 * Tests for contactsSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { createContactsSlice } from '../slices/contactsSlice';
import type { AppState, Contact } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()((...a) => ({
    ...createContactsSlice(...a),

    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    avatarPath: null,
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),

    conversations: {},
    conversationIds: [],
    activeConversationId: null,
    setConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),

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
    upsertReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),

    messages: {},
    messageIdsByConversation: {},
    hasMoreMessages: {},
    setMessages: jest.fn(),
    addMessage: jest.fn(),
    addOptimisticMessage: jest.fn(),
    updateMessageSyncStatus: jest.fn(),
    markMessageRead: jest.fn(),
    setHasMore: jest.fn(),

    colorScheme: 'system',
    activeTab: 'threads',
    composerDraft: null,
    isComposerOpen: false,
    syncOverallStatus: 'synced',
    setColorScheme: jest.fn(),
    setActiveTab: jest.fn(),
    setComposerDraft: jest.fn(),
    toggleComposer: jest.fn(),
    setSyncStatus: jest.fn(),
  }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
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
