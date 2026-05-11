/**
 * Tests for authSlice — initial state, actions, and security constraints.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createAuthSlice } from '../slices/authSlice';
import type { AppState } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory for isolated slice testing
// ---------------------------------------------------------------------------

/** Creates a minimal store containing only authSlice state/actions for testing. */
function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    // Auth slice under test
    ...createAuthSlice(...a),

    // Stub out all other slices — only the auth-related fields are exercised here
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
    removeReply: jest.fn(),
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
// Tests
// ---------------------------------------------------------------------------

describe('authSlice — initial state', () => {
  it('starts unauthenticated with null user fields', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userId).toBeNull();
    expect(state.username).toBeNull();
    expect(state.displayName).toBeNull();
    expect(state.avatarPath).toBeNull();
  });
});

describe('authSlice — setUser', () => {
  it('sets all user fields and marks authenticated', () => {
    const store = makeStore();
    store.getState().setUser({
      userId: 'user-123',
      username: 'alice',
      displayName: 'Alice Smith',
      avatarPath: '/avatars/alice.jpg',
    });
    const state = store.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userId).toBe('user-123');
    expect(state.username).toBe('alice');
    expect(state.displayName).toBe('Alice Smith');
    expect(state.avatarPath).toBe('/avatars/alice.jpg');
  });

  it('accepts null displayName and avatarPath', () => {
    const store = makeStore();
    store.getState().setUser({
      userId: 'user-456',
      username: 'bob',
      displayName: null,
      avatarPath: null,
    });
    const state = store.getState();
    expect(state.displayName).toBeNull();
    expect(state.avatarPath).toBeNull();
  });
});

describe('authSlice — clearAuth', () => {
  it('resets all fields to unauthenticated defaults', () => {
    const store = makeStore();
    store.getState().setUser({
      userId: 'user-123',
      username: 'alice',
      displayName: 'Alice',
      avatarPath: null,
    });
    store.getState().clearAuth();
    const state = store.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userId).toBeNull();
    expect(state.username).toBeNull();
    expect(state.displayName).toBeNull();
    expect(state.avatarPath).toBeNull();
  });
});

describe('authSlice — setAuthenticated', () => {
  it('sets isAuthenticated to true', () => {
    const store = makeStore();
    store.getState().setAuthenticated(true);
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it('sets isAuthenticated to false', () => {
    const store = makeStore();
    store.getState().setAuthenticated(true);
    store.getState().setAuthenticated(false);
    expect(store.getState().isAuthenticated).toBe(false);
  });
});

describe('authSlice — security constraints', () => {
  it('does NOT contain any token or key field', () => {
    const store = makeStore();
    const state = store.getState() as unknown as Record<string, unknown>;
    const forbidden = [
      'token',
      'accessToken',
      'refreshToken',
      'jwtToken',
      'authToken',
      'identityKey',
      'privateKey',
      'signalingKey',
      'encryptionKey',
      'registrationId',
    ];
    for (const field of forbidden) {
      expect(field in state).toBe(false);
    }
  });
});
