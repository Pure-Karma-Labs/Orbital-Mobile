/**
 * Tests for messagesSlice — initial state, actions, and optimistic update flow.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMessagesSlice } from '../slices/messagesSlice';
import type { AppState, Message } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createMessagesSlice(...a),

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

    contacts: {},
    setContacts: jest.fn(),
    upsertContact: jest.fn(),
    removeContact: jest.fn(),

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
  })));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    type: 'message',
    body: 'Hello',
    serverTimestamp: 1000,
    receivedAt: 1001,
    read: false,
    expiresAt: null,
    syncStatus: 'synced',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('messagesSlice — initial state', () => {
  it('starts with empty messages and no pagination state', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.messages).toEqual({});
    expect(state.messageIdsByConversation).toEqual({});
    expect(state.hasMoreMessages).toEqual({});
  });
});

describe('messagesSlice — setMessages', () => {
  it('populates messages ordered by serverTimestamp ascending', () => {
    const store = makeStore();
    const m1 = makeMessage({ id: 'msg-1', serverTimestamp: 2000 });
    const m2 = makeMessage({ id: 'msg-2', serverTimestamp: 1000 });
    store.getState().setMessages('conv-1', [m1, m2]);
    expect(store.getState().messageIdsByConversation['conv-1']).toEqual(['msg-2', 'msg-1']);
  });
});

describe('messagesSlice — addMessage', () => {
  it('appends a new message', () => {
    const store = makeStore();
    const m1 = makeMessage({ id: 'msg-1' });
    store.getState().addMessage(m1);
    expect(store.getState().messages['msg-1']).toEqual(m1);
    expect(store.getState().messageIdsByConversation['conv-1']).toContain('msg-1');
  });

  it('does not duplicate ID on repeated call', () => {
    const store = makeStore();
    const m1 = makeMessage({ id: 'msg-1' });
    store.getState().addMessage(m1);
    store.getState().addMessage(m1);
    const ids = store.getState().messageIdsByConversation['conv-1'];
    expect(ids.filter((id) => id === 'msg-1')).toHaveLength(1);
  });
});

describe('messagesSlice — addOptimisticMessage', () => {
  it('adds message with pending sync status', () => {
    const store = makeStore();
    const m = makeMessage({ id: 'opt-msg-1', syncStatus: 'synced' });
    store.getState().addOptimisticMessage(m);
    expect(store.getState().messages['opt-msg-1'].syncStatus).toBe('pending');
  });

  it('optimistic flow: pending → syncing → synced', () => {
    const store = makeStore();
    const m = makeMessage({ id: 'opt-msg-2' });
    store.getState().addOptimisticMessage(m);
    expect(store.getState().messages['opt-msg-2'].syncStatus).toBe('pending');

    store.getState().updateMessageSyncStatus('opt-msg-2', 'syncing');
    expect(store.getState().messages['opt-msg-2'].syncStatus).toBe('syncing');

    store.getState().updateMessageSyncStatus('opt-msg-2', 'synced');
    expect(store.getState().messages['opt-msg-2'].syncStatus).toBe('synced');
  });
});

describe('messagesSlice — markMessageRead', () => {
  it('sets read to true', () => {
    const store = makeStore();
    const m = makeMessage({ id: 'msg-1', read: false });
    store.getState().addMessage(m);
    store.getState().markMessageRead('msg-1');
    expect(store.getState().messages['msg-1'].read).toBe(true);
  });

  it('is a no-op for unknown message', () => {
    const store = makeStore();
    expect(() => store.getState().markMessageRead('nonexistent')).not.toThrow();
  });
});

describe('messagesSlice — setHasMore', () => {
  it('sets and updates hasMoreMessages per conversation', () => {
    const store = makeStore();
    store.getState().setHasMore('conv-1', true);
    expect(store.getState().hasMoreMessages['conv-1']).toBe(true);
    store.getState().setHasMore('conv-1', false);
    expect(store.getState().hasMoreMessages['conv-1']).toBe(false);
  });
});
