/**
 * Tests for uiSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { createUISlice } from '../slices/uiSlice';
import type { AppState, Draft } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()((...a) => ({
    ...createUISlice(...a),

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

    contacts: {},
    setContacts: jest.fn(),
    upsertContact: jest.fn(),
    removeContact: jest.fn(),
  }));
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
