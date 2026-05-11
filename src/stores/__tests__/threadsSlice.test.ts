/**
 * Tests for threadsSlice — initial state, actions, and optimistic update flow.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createThreadsSlice } from '../slices/threadsSlice';
import type { AppState, Reply, Thread } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createThreadsSlice(...a),

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

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    conversationId: 'conv-1',
    authorId: 'user-1',
    authorUsername: 'user-1',
    title: 'Test Thread',
    body: 'Hello world',
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeReply(overrides: Partial<Reply> = {}): Reply {
  return {
    id: 'reply-1',
    threadId: 'thread-1',
    authorId: 'user-1',
    authorUsername: 'user-1',
    body: 'Reply body',
    parentReplyId: null,
    depth: 0,
    createdAt: 1100,
    updatedAt: 1100,
    syncStatus: 'synced',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('threadsSlice — initial state', () => {
  it('starts with empty maps and null active thread', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.threads).toEqual({});
    expect(state.threadIdsByConversation).toEqual({});
    expect(state.replies).toEqual({});
    expect(state.replyIdsByThread).toEqual({});
    expect(state.activeThreadId).toBeNull();
  });
});

describe('threadsSlice — setThreads', () => {
  it('populates threads map and IDs by conversation', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1', createdAt: 2000 });
    const t2 = makeThread({ id: 'thread-2', createdAt: 1000 });
    store.getState().setThreads('conv-1', [t1, t2]);
    const state = store.getState();
    expect(state.threads['thread-1']).toEqual(t1);
    expect(state.threads['thread-2']).toEqual(t2);
    // Ordered by createdAt descending
    expect(state.threadIdsByConversation['conv-1']).toEqual(['thread-1', 'thread-2']);
  });

  it('does not affect threads from other conversations', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1', conversationId: 'conv-1' });
    const t2 = makeThread({ id: 'thread-2', conversationId: 'conv-2' });
    store.getState().setThreads('conv-1', [t1]);
    store.getState().setThreads('conv-2', [t2]);
    expect(store.getState().threadIdsByConversation['conv-1']).toEqual(['thread-1']);
    expect(store.getState().threadIdsByConversation['conv-2']).toEqual(['thread-2']);
  });
});

describe('threadsSlice — upsertThread', () => {
  it('adds a thread and prepends its ID', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1' });
    store.getState().setThreads('conv-1', [t1]);
    const t2 = makeThread({ id: 'thread-2' });
    store.getState().upsertThread(t2);
    expect(store.getState().threadIdsByConversation['conv-1']).toContain('thread-2');
  });

  it('updates an existing thread without duplicating the ID', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1', replyCount: 0 });
    store.getState().setThreads('conv-1', [t1]);
    store.getState().upsertThread({ ...t1, replyCount: 3 });
    const state = store.getState();
    expect(state.threads['thread-1'].replyCount).toBe(3);
    expect(state.threadIdsByConversation['conv-1'].filter((id) => id === 'thread-1')).toHaveLength(1);
  });
});

describe('threadsSlice — removeThread', () => {
  it('removes thread from map and IDs list', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1' });
    store.getState().setThreads('conv-1', [t1]);
    store.getState().removeThread('thread-1');
    const state = store.getState();
    expect('thread-1' in state.threads).toBe(false);
    expect(state.threadIdsByConversation['conv-1']).not.toContain('thread-1');
  });

  it('clears activeThreadId when active thread is removed', () => {
    const store = makeStore();
    const t1 = makeThread({ id: 'thread-1' });
    store.getState().setThreads('conv-1', [t1]);
    store.getState().setActiveThread('thread-1');
    store.getState().removeThread('thread-1');
    expect(store.getState().activeThreadId).toBeNull();
  });
});

describe('threadsSlice — setReplies', () => {
  it('preserves caller-supplied order', () => {
    const store = makeStore();
    const r1 = makeReply({ id: 'reply-1', createdAt: 1200 });
    const r2 = makeReply({ id: 'reply-2', createdAt: 1100 });
    store.getState().setReplies('thread-1', [r1, r2]);
    expect(store.getState().replyIdsByThread['thread-1']).toEqual(['reply-1', 'reply-2']);
  });
});

describe('threadsSlice — appendReplies', () => {
  it('preserves caller-supplied order and deduplicates', () => {
    const store = makeStore();
    const r1 = makeReply({ id: 'reply-1', createdAt: 1200 });
    const r2 = makeReply({ id: 'reply-2', createdAt: 1100 });
    store.getState().setReplies('thread-1', [r1]);
    // Append r2 and a duplicate of r1
    store.getState().appendReplies('thread-1', [r2, r1]);
    const ids = store.getState().replyIdsByThread['thread-1'];
    expect(ids).toEqual(['reply-1', 'reply-2']);
  });
});

describe('threadsSlice — upsertReply', () => {
  it('appends a new reply ID', () => {
    const store = makeStore();
    const r1 = makeReply({ id: 'reply-1' });
    store.getState().setReplies('thread-1', [r1]);
    const r2 = makeReply({ id: 'reply-2' });
    store.getState().upsertReply(r2);
    expect(store.getState().replyIdsByThread['thread-1']).toContain('reply-2');
  });
});

describe('threadsSlice — optimistic updates', () => {
  it('addOptimisticThread sets syncStatus to pending', () => {
    const store = makeStore();
    const thread = makeThread({ id: 'optimistic-1', syncStatus: 'synced' });
    store.getState().addOptimisticThread(thread);
    expect(store.getState().threads['optimistic-1'].syncStatus).toBe('pending');
  });

  it('addOptimisticReply sets syncStatus to pending', () => {
    const store = makeStore();
    const reply = makeReply({ id: 'opt-reply-1', syncStatus: 'synced' });
    store.getState().addOptimisticReply(reply);
    expect(store.getState().replies['opt-reply-1'].syncStatus).toBe('pending');
  });

  it('full optimistic flow: add pending → syncing → synced', () => {
    const store = makeStore();
    const thread = makeThread({ id: 'thread-opt' });

    // 1. Add optimistically
    store.getState().addOptimisticThread(thread);
    expect(store.getState().threads['thread-opt'].syncStatus).toBe('pending');

    // 2. Mark syncing (upload started)
    store.getState().updateThreadSyncStatus('thread-opt', 'syncing');
    expect(store.getState().threads['thread-opt'].syncStatus).toBe('syncing');

    // 3. Mark synced (server confirmed)
    store.getState().updateThreadSyncStatus('thread-opt', 'synced');
    expect(store.getState().threads['thread-opt'].syncStatus).toBe('synced');
  });

  it('optimistic reply flow: add pending → failed', () => {
    const store = makeStore();
    const reply = makeReply({ id: 'reply-opt' });
    store.getState().addOptimisticReply(reply);
    store.getState().updateReplySyncStatus('reply-opt', 'failed');
    expect(store.getState().replies['reply-opt'].syncStatus).toBe('failed');
  });

  it('addOptimisticReply inserts nested reply after parent descendants', () => {
    const store = makeStore();
    // Seed the store with tree-ordered replies: A (depth 0), A1 (depth 1), B (depth 0)
    const replyA = makeReply({ id: 'A', depth: 0, parentReplyId: null });
    const replyA1 = makeReply({ id: 'A1', depth: 1, parentReplyId: 'A' });
    const replyB = makeReply({ id: 'B', depth: 0, parentReplyId: null });
    store.getState().setReplies('thread-1', [replyA, replyA1, replyB]);

    // Add a new nested reply targeting A
    const newReply = makeReply({
      id: 'A2',
      depth: 1,
      parentReplyId: 'A',
      syncStatus: 'synced',
    });
    store.getState().addOptimisticReply(newReply);

    // Should be inserted after A1 (the last descendant of A) but before B
    expect(store.getState().replyIdsByThread['thread-1']).toEqual([
      'A',
      'A1',
      'A2',
      'B',
    ]);
    expect(store.getState().replies['A2'].syncStatus).toBe('pending');
  });
});
