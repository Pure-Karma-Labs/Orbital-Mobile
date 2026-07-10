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

  it('resets a stale needsTermsAcceptance on account switch', () => {
    const store = makeStore();
    store.getState().setNeedsTermsAcceptance(true);
    store.getState().setUser({
      userId: 'user-789',
      username: 'carol',
      displayName: null,
      avatarPath: null,
    });
    expect(store.getState().needsTermsAcceptance).toBe(false);
  });
});

describe('authSlice — setNeedsTermsAcceptance', () => {
  it('sets and clears the flag', () => {
    const store = makeStore();
    expect(store.getState().needsTermsAcceptance).toBe(false);
    store.getState().setNeedsTermsAcceptance(true);
    expect(store.getState().needsTermsAcceptance).toBe(true);
    store.getState().setNeedsTermsAcceptance(false);
    expect(store.getState().needsTermsAcceptance).toBe(false);
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
    store.getState().setNeedsTermsAcceptance(true);
    store.getState().clearAuth();
    const state = store.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userId).toBeNull();
    expect(state.username).toBeNull();
    expect(state.displayName).toBeNull();
    expect(state.avatarPath).toBeNull();
    expect(state.needsTermsAcceptance).toBe(false);
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

describe('authSlice — identityKeyConflict', () => {
  it('initializes to false', () => {
    const store = makeStore();
    expect(store.getState().identityKeyConflict).toBe(false);
  });

  it('setIdentityKeyConflict sets the flag', () => {
    const store = makeStore();
    store.getState().setIdentityKeyConflict(true);
    expect(store.getState().identityKeyConflict).toBe(true);
    store.getState().setIdentityKeyConflict(false);
    expect(store.getState().identityKeyConflict).toBe(false);
  });

  it('setUser resets identityKeyConflict to false', () => {
    const store = makeStore();
    store.getState().setIdentityKeyConflict(true);
    store.getState().setUser({ userId: 'u1', username: 'a', displayName: null, avatarPath: null });
    expect(store.getState().identityKeyConflict).toBe(false);
  });

  it('clearAuth resets identityKeyConflict to false', () => {
    const store = makeStore();
    store.getState().setIdentityKeyConflict(true);
    store.getState().clearAuth();
    expect(store.getState().identityKeyConflict).toBe(false);
  });
});

describe('authSlice — keyRecoveryInProgress', () => {
  it('initializes to false', () => {
    const store = makeStore();
    expect(store.getState().keyRecoveryInProgress).toBe(false);
  });

  it('setKeyRecoveryInProgress sets the flag', () => {
    const store = makeStore();
    store.getState().setKeyRecoveryInProgress(true);
    expect(store.getState().keyRecoveryInProgress).toBe(true);
  });

  it('setUser resets keyRecoveryInProgress to false', () => {
    const store = makeStore();
    store.getState().setKeyRecoveryInProgress(true);
    store.getState().setUser({ userId: 'u1', username: 'a', displayName: null, avatarPath: null });
    expect(store.getState().keyRecoveryInProgress).toBe(false);
  });

  it('clearAuth resets keyRecoveryInProgress to false', () => {
    const store = makeStore();
    store.getState().setKeyRecoveryInProgress(true);
    store.getState().clearAuth();
    expect(store.getState().keyRecoveryInProgress).toBe(false);
  });
});

describe('authSlice — email (transient PII)', () => {
  it('initializes to null', () => {
    const store = makeStore();
    expect(store.getState().email).toBeNull();
  });

  it('setEmail sets and clears', () => {
    const store = makeStore();
    store.getState().setEmail('test@example.com');
    expect(store.getState().email).toBe('test@example.com');
    store.getState().setEmail(null);
    expect(store.getState().email).toBeNull();
  });

  it('setUser nulls email (PII cleanup)', () => {
    const store = makeStore();
    store.getState().setEmail('test@example.com');
    store.getState().setUser({ userId: 'u1', username: 'a', displayName: null, avatarPath: null });
    expect(store.getState().email).toBeNull();
  });

  it('clearAuth nulls email (PII cleanup)', () => {
    const store = makeStore();
    store.getState().setEmail('test@example.com');
    store.getState().clearAuth();
    expect(store.getState().email).toBeNull();
  });
});

describe('authSlice — conflictSource', () => {
  it('initializes to null', () => {
    const store = makeStore();
    expect(store.getState().conflictSource).toBeNull();
  });

  it('setConflictSource sets push/local/null', () => {
    const store = makeStore();
    store.getState().setConflictSource('push');
    expect(store.getState().conflictSource).toBe('push');
    store.getState().setConflictSource('local');
    expect(store.getState().conflictSource).toBe('local');
    store.getState().setConflictSource(null);
    expect(store.getState().conflictSource).toBeNull();
  });

  it('setUser resets conflictSource to null', () => {
    const store = makeStore();
    store.getState().setConflictSource('push');
    store.getState().setUser({ userId: 'u1', username: 'a', displayName: null, avatarPath: null });
    expect(store.getState().conflictSource).toBeNull();
  });

  it('clearAuth resets conflictSource to null', () => {
    const store = makeStore();
    store.getState().setConflictSource('local');
    store.getState().clearAuth();
    expect(store.getState().conflictSource).toBeNull();
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
