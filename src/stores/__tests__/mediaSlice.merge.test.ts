/**
 * Tests for mediaSlice merge semantics (W1) — mergeMediaForThread,
 * mergeMediaForReply, and mergeMediaBatch.
 *
 * Focus: union (not replace) on index maps; downloading no-clobber guard;
 * order stability; dedup; removeMedia intact after merge.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMediaSlice } from '../slices/mediaSlice';
import type { AppState, MediaItem } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory (same pattern as mediaSlice.test.ts)
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(
    devtools(
      (...a) => ({
        ...createMediaSlice(...a),
        // Auth stubs
        isAuthenticated: false, userId: null, username: null, displayName: null,
        avatarPath: null, avatarDigest: null, needsTermsAcceptance: false,
        identityKeyConflict: false, keyRecoveryInProgress: false, email: null,
        conflictSource: null,
        setUser: jest.fn(), clearAuth: jest.fn(), setAuthenticated: jest.fn(),
        updateProfile: jest.fn(), setNeedsTermsAcceptance: jest.fn(),
        setIdentityKeyConflict: jest.fn(), setKeyRecoveryInProgress: jest.fn(),
        setEmail: jest.fn(), setConflictSource: jest.fn(),
        // Conversations stubs
        conversations: {}, conversationIds: [], activeConversationId: null,
        viewingConversationId: null,
        setConversations: jest.fn(), setGroupConversations: jest.fn(),
        upsertConversation: jest.fn(), removeConversation: jest.fn(),
        setActiveConversation: jest.fn(), updateUnreadCount: jest.fn(),
        incrementUnreadCount: jest.fn(), markConversationRead: jest.fn(),
        setViewingConversation: jest.fn(), bumpLastMessageAt: jest.fn(),
        // Threads stubs
        threads: {}, threadIdsByConversation: {}, replies: {}, replyIdsByThread: {},
        activeThreadId: null, threadLastViewedAt: {},
        setThreads: jest.fn(), upsertThread: jest.fn(), removeThread: jest.fn(),
        setActiveThread: jest.fn(), setReplies: jest.fn(), appendReplies: jest.fn(),
        upsertReply: jest.fn(), removeReply: jest.fn(), addOptimisticThread: jest.fn(),
        addOptimisticReply: jest.fn(), updateThreadSyncStatus: jest.fn(),
        updateReplySyncStatus: jest.fn(), markThreadViewed: jest.fn(),
        // Contacts stubs
        contacts: {},
        setContacts: jest.fn(), mergeContacts: jest.fn(), upsertContact: jest.fn(),
        removeContact: jest.fn(), setContactVerifiedStatus: jest.fn(),
        // UI stubs
        colorScheme: 'system' as const, activeTab: 'threads' as const,
        composerDraft: null, isComposerOpen: false,
        syncOverallStatus: 'synced' as const, soundEnabled: true,
        setColorScheme: jest.fn(), setActiveTab: jest.fn(),
        setComposerDraft: jest.fn(), toggleComposer: jest.fn(),
        setSyncStatus: jest.fn(), setSoundEnabled: jest.fn(),
        // Connection stubs
        connectionStatus: 'disconnected' as const, lastConnectedAt: null,
        reconnectAttempt: 0, typingUsers: {},
        setConnectionStatus: jest.fn(), setLastConnectedAt: jest.fn(),
        setReconnectAttempt: jest.fn(), addTypingUser: jest.fn(),
        removeTypingUser: jest.fn(), clearTypingUsers: jest.fn(),
        // Notification stubs
        pushPermissionGranted: false, pushToken: null,
        setPushPermission: jest.fn(), setPushToken: jest.fn(),
        // BlockedUsers stubs
        blockedUserIds: [], blockedUserProfiles: {},
        blockUser: jest.fn(), unblockUser: jest.fn(),
        resetBlockedUsers: jest.fn(), hydrateBlockedUsers: jest.fn(),
        // Report stubs
        reportTarget: null, openReportSheet: jest.fn(), closeReportSheet: jest.fn(),
      }),
      { name: 'mediaSlice-merge-test' },
    ),
  );
}

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-1',
    threadId: 'thread-1',
    replyId: null,
    contentType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 1024,
    width: 640, height: 480,
    duration: null, blurHash: null,
    localPath: null, thumbnailPath: null,
    downloadState: 'pending',
    uploadState: 'done',
    expiresAt: null, hasKeys: true,
    thumbnailMediaId: null, isThumbnail: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mergeMediaForThread — union semantics
// ---------------------------------------------------------------------------

describe('mergeMediaForThread', () => {
  it('seeds index from empty', () => {
    const store = makeStore();
    const item = makeItem({ id: 'a' });
    store.getState().mergeMediaForThread('t1', [item]);
    expect(store.getState().mediaIdsByThread['t1']).toEqual(['a']);
    expect(store.getState().media['a']).toEqual(item);
  });

  it('unions new items into existing index (append-at-end)', () => {
    const store = makeStore();
    store.getState().mergeMediaForThread('t1', [makeItem({ id: 'a' })]);
    store.getState().mergeMediaForThread('t1', [makeItem({ id: 'b' })]);
    expect(store.getState().mediaIdsByThread['t1']).toEqual(['a', 'b']);
  });

  it('does NOT replace — existing IDs stay, partial server list is additive', () => {
    const store = makeStore();
    const localOnly = makeItem({ id: 'local-only', localPath: '/path' });
    store.getState().mergeMediaForThread('t1', [localOnly]);
    // Server returns only 'server-new'
    store.getState().mergeMediaForThread('t1', [makeItem({ id: 'server-new' })]);
    const ids = store.getState().mediaIdsByThread['t1'];
    expect(ids).toContain('local-only');
    expect(ids).toContain('server-new');
  });

  it('deduplicates IDs (Set-dedup)', () => {
    const store = makeStore();
    store.getState().mergeMediaForThread('t1', [makeItem({ id: 'a' })]);
    // Merge same item again
    store.getState().mergeMediaForThread('t1', [makeItem({ id: 'a' })]);
    expect(store.getState().mediaIdsByThread['t1']).toEqual(['a']);
  });

  it('preserves order: existing first, new appended', () => {
    const store = makeStore();
    store.getState().mergeMediaForThread('t1', [
      makeItem({ id: 'c' }),
      makeItem({ id: 'a' }),
    ]);
    store.getState().mergeMediaForThread('t1', [
      makeItem({ id: 'b' }),
      makeItem({ id: 'a' }), // dup
    ]);
    expect(store.getState().mediaIdsByThread['t1']).toEqual(['c', 'a', 'b']);
  });

  it('does not clobber items with downloadState === downloading', () => {
    const store = makeStore();
    const downloading = makeItem({ id: 'a', downloadState: 'downloading', localPath: '/tmp' });
    store.getState().mergeMediaForThread('t1', [downloading]);
    // Server sends same item with downloadState: pending
    const serverItem = makeItem({ id: 'a', downloadState: 'pending' });
    store.getState().mergeMediaForThread('t1', [serverItem]);
    // Should still be 'downloading'
    expect(store.getState().media['a'].downloadState).toBe('downloading');
  });
});

// ---------------------------------------------------------------------------
// mergeMediaForReply — same semantics
// ---------------------------------------------------------------------------

describe('mergeMediaForReply', () => {
  it('unions new items into existing reply index', () => {
    const store = makeStore();
    store.getState().mergeMediaForReply('r1', [makeItem({ id: 'a', replyId: 'r1' })]);
    store.getState().mergeMediaForReply('r1', [makeItem({ id: 'b', replyId: 'r1' })]);
    expect(store.getState().mediaIdsByReply['r1']).toEqual(['a', 'b']);
  });

  it('deduplicates IDs', () => {
    const store = makeStore();
    store.getState().mergeMediaForReply('r1', [makeItem({ id: 'x', replyId: 'r1' })]);
    store.getState().mergeMediaForReply('r1', [makeItem({ id: 'x', replyId: 'r1' })]);
    expect(store.getState().mediaIdsByReply['r1']).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// mergeMediaBatch — single set() across indexes
// ---------------------------------------------------------------------------

describe('mergeMediaBatch', () => {
  it('merges thread + reply indexes in one set()', () => {
    const store = makeStore();
    const batch = new Map<string, { type: 'thread' | 'reply'; items: MediaItem[] }>();
    batch.set('t1', { type: 'thread', items: [makeItem({ id: 'a' })] });
    batch.set('r1', { type: 'reply', items: [makeItem({ id: 'b', replyId: 'r1' })] });
    store.getState().mergeMediaBatch(batch);

    expect(store.getState().mediaIdsByThread['t1']).toEqual(['a']);
    expect(store.getState().mediaIdsByReply['r1']).toEqual(['b']);
    expect(store.getState().media['a']).toBeDefined();
    expect(store.getState().media['b']).toBeDefined();
  });

  it('does not clobber downloading items', () => {
    const store = makeStore();
    const downloading = makeItem({ id: 'x', downloadState: 'downloading' });
    store.getState().upsertMedia(downloading);

    const batch = new Map<string, { type: 'thread' | 'reply'; items: MediaItem[] }>();
    batch.set('t1', { type: 'thread', items: [makeItem({ id: 'x', downloadState: 'pending' })] });
    store.getState().mergeMediaBatch(batch);

    expect(store.getState().media['x'].downloadState).toBe('downloading');
  });
});

// ---------------------------------------------------------------------------
// removeMedia — still the sole removal path
// ---------------------------------------------------------------------------

describe('removeMedia — intact after merge changes', () => {
  it('removes from thread index and media map', () => {
    const store = makeStore();
    store.getState().mergeMediaForThread('t1', [
      makeItem({ id: 'a', threadId: 't1' }),
      makeItem({ id: 'b', threadId: 't1' }),
    ]);
    store.getState().removeMedia('a');
    expect(store.getState().mediaIdsByThread['t1']).toEqual(['b']);
    expect('a' in store.getState().media).toBe(false);
  });

  it('removes from reply index and media map', () => {
    const store = makeStore();
    store.getState().mergeMediaForReply('r1', [
      makeItem({ id: 'a', threadId: null, replyId: 'r1' }),
    ]);
    store.getState().removeMedia('a');
    expect(store.getState().mediaIdsByReply['r1']).not.toContain('a');
    expect('a' in store.getState().media).toBe(false);
  });
});
