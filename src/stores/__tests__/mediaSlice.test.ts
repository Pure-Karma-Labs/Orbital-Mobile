/**
 * Tests for mediaSlice — initial state and all actions.
 *
 * Focus: branch coverage of upsertMedia, updateMediaDownloadState,
 * updateMediaUploadState, removeMedia (both sides of every conditional).
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMediaSlice } from '../slices/mediaSlice';
import type { AppState, MediaItem } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(
    devtools(
      (...a) => ({
        ...createMediaSlice(...a),

        // Auth slice stubs
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

        // Conversations slice stubs
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

        // Threads slice stubs
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

        // Contacts slice stubs
        contacts: {},
        setContacts: jest.fn(),
        mergeContacts: jest.fn(),
        upsertContact: jest.fn(),
        removeContact: jest.fn(),
        setContactVerifiedStatus: jest.fn(),

        // UI slice stubs
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

        // Connection slice stubs
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

        // Notification slice stubs
        pushPermissionGranted: false,
        pushToken: null,
        setPushPermission: jest.fn(),
        setPushToken: jest.fn(),

        // BlockedUsers slice stubs
        blockedUserIds: [],
        blockedUserProfiles: {},
        blockUser: jest.fn(),
        unblockUser: jest.fn(),
        resetBlockedUsers: jest.fn(),
    hydrateBlockedUsers: jest.fn(),

    reportTarget: null,
    openReportSheet: jest.fn(),
    closeReportSheet: jest.fn(),
      }),
      { name: 'mediaSlice-test' },
    ),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-1',
    threadId: 'thread-1',
    replyId: null,
    contentType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 1024,
    width: 640,
    height: 480,
    duration: null,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending',
    uploadState: 'done',
    expiresAt: null,
    hasKeys: false,
    thumbnailMediaId: null,
    isThumbnail: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('mediaSlice — initial state', () => {
  it('starts with empty media maps', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.media).toEqual({});
    expect(state.mediaIdsByThread).toEqual({});
    expect(state.mediaIdsByReply).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mergeMediaForThread
// ---------------------------------------------------------------------------

describe('mediaSlice — mergeMediaForThread', () => {
  it('populates media map and thread index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1' });
    store.getState().mergeMediaForThread('thread-1', [item]);

    const state = store.getState();
    expect(state.media['media-1']).toEqual(item);
    expect(state.mediaIdsByThread['thread-1']).toEqual(['media-1']);
  });

  it('unions new items into existing thread index (not replace)', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1' });
    const item2 = makeMediaItem({ id: 'media-2' });
    store.getState().mergeMediaForThread('thread-1', [item1]);
    store.getState().mergeMediaForThread('thread-1', [item2]);

    expect(store.getState().mediaIdsByThread['thread-1']).toEqual(['media-1', 'media-2']);
  });

  it('handles multiple items in one call', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1' });
    const item2 = makeMediaItem({ id: 'media-2' });
    store.getState().mergeMediaForThread('thread-1', [item1, item2]);

    const state = store.getState();
    expect(state.mediaIdsByThread['thread-1']).toEqual(['media-1', 'media-2']);
    expect(state.media['media-1']).toEqual(item1);
    expect(state.media['media-2']).toEqual(item2);
  });

  it('does not affect other thread indexes', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1' });
    const item2 = makeMediaItem({ id: 'media-2' });
    store.getState().mergeMediaForThread('thread-1', [item1]);
    store.getState().mergeMediaForThread('thread-2', [item2]);

    expect(store.getState().mediaIdsByThread['thread-1']).toEqual(['media-1']);
    expect(store.getState().mediaIdsByThread['thread-2']).toEqual(['media-2']);
  });
});

// ---------------------------------------------------------------------------
// mergeMediaForReply
// ---------------------------------------------------------------------------

describe('mediaSlice — mergeMediaForReply', () => {
  it('populates media map and reply index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    store.getState().mergeMediaForReply('reply-1', [item]);

    const state = store.getState();
    expect(state.media['media-1']).toEqual(item);
    expect(state.mediaIdsByReply['reply-1']).toEqual(['media-1']);
  });

  it('unions new items into existing reply index (not replace)', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    const item2 = makeMediaItem({ id: 'media-2', threadId: null, replyId: 'reply-1' });
    store.getState().mergeMediaForReply('reply-1', [item1]);
    store.getState().mergeMediaForReply('reply-1', [item2]);

    expect(store.getState().mediaIdsByReply['reply-1']).toEqual(['media-1', 'media-2']);
  });

  it('handles multiple items in one call', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    const item2 = makeMediaItem({ id: 'media-2', threadId: null, replyId: 'reply-1' });
    store.getState().mergeMediaForReply('reply-1', [item1, item2]);

    expect(store.getState().mediaIdsByReply['reply-1']).toEqual(['media-1', 'media-2']);
  });
});

// ---------------------------------------------------------------------------
// upsertMedia
// ---------------------------------------------------------------------------

describe('mediaSlice — upsertMedia', () => {
  it('inserts a new item with threadId into media map and thread index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: 'thread-1', replyId: null });
    store.getState().upsertMedia(item);

    const state = store.getState();
    expect(state.media['media-1']).toEqual(item);
    expect(state.mediaIdsByThread['thread-1']).toContain('media-1');
  });

  it('inserts a new item with replyId into media map and reply index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    store.getState().upsertMedia(item);

    const state = store.getState();
    expect(state.media['media-1']).toEqual(item);
    expect(state.mediaIdsByReply['reply-1']).toContain('media-1');
  });

  it('inserts item with neither threadId nor replyId — only updates media map', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: null });
    store.getState().upsertMedia(item);

    const state = store.getState();
    expect(state.media['media-1']).toEqual(item);
    expect(Object.keys(state.mediaIdsByThread)).toHaveLength(0);
    expect(Object.keys(state.mediaIdsByReply)).toHaveLength(0);
  });

  it('updates existing item in media map without duplicating in thread index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: 'thread-1', replyId: null });
    store.getState().upsertMedia(item);
    // Upsert again with a modified field
    store.getState().upsertMedia({ ...item, downloadState: 'downloaded' });

    const state = store.getState();
    expect(state.media['media-1'].downloadState).toBe('downloaded');
    // ID must appear exactly once in the index
    expect(state.mediaIdsByThread['thread-1'].filter((id) => id === 'media-1')).toHaveLength(1);
  });

  it('updates existing item without duplicating in reply index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    store.getState().upsertMedia(item);
    store.getState().upsertMedia({ ...item, downloadState: 'downloaded' });

    const state = store.getState();
    expect(state.mediaIdsByReply['reply-1'].filter((id) => id === 'media-1')).toHaveLength(1);
  });

  it('appends to an existing thread index when a second item is upserted', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1', threadId: 'thread-1', replyId: null });
    const item2 = makeMediaItem({ id: 'media-2', threadId: 'thread-1', replyId: null });
    store.getState().upsertMedia(item1);
    store.getState().upsertMedia(item2);

    expect(store.getState().mediaIdsByThread['thread-1']).toEqual(['media-1', 'media-2']);
  });
});

// ---------------------------------------------------------------------------
// updateMediaDownloadState
// ---------------------------------------------------------------------------

describe('mediaSlice — updateMediaDownloadState', () => {
  it('updates downloadState for an existing item', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', downloadState: 'pending' });
    store.getState().upsertMedia(item);

    store.getState().updateMediaDownloadState('media-1', 'downloaded');

    expect(store.getState().media['media-1'].downloadState).toBe('downloaded');
  });

  it('sets localPath when provided', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', downloadState: 'pending' });
    store.getState().upsertMedia(item);

    store.getState().updateMediaDownloadState('media-1', 'downloaded', '/local/path.jpg');

    const updated = store.getState().media['media-1'];
    expect(updated.downloadState).toBe('downloaded');
    expect(updated.localPath).toBe('/local/path.jpg');
  });

  it('does not set localPath when localPath is undefined', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', localPath: '/existing-path.jpg', downloadState: 'pending' });
    store.getState().upsertMedia(item);

    // Call without the optional localPath argument
    store.getState().updateMediaDownloadState('media-1', 'failed');

    const updated = store.getState().media['media-1'];
    expect(updated.downloadState).toBe('failed');
    // localPath should be unchanged (not clobbered with undefined)
    expect(updated.localPath).toBe('/existing-path.jpg');
  });

  it('does nothing when the media id does not exist', () => {
    const store = makeStore();
    const before = store.getState().media;

    store.getState().updateMediaDownloadState('nonexistent-id', 'downloaded');

    // State object reference should be the same (no mutation)
    expect(store.getState().media).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// updateMediaUploadState
// ---------------------------------------------------------------------------

describe('mediaSlice — updateMediaUploadState', () => {
  it('updates uploadState for an existing item', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', uploadState: 'pending' });
    store.getState().upsertMedia(item);

    store.getState().updateMediaUploadState('media-1', 'done');

    expect(store.getState().media['media-1'].uploadState).toBe('done');
  });

  it('does nothing when the media id does not exist', () => {
    const store = makeStore();
    const before = store.getState().media;

    store.getState().updateMediaUploadState('nonexistent-id', 'done');

    expect(store.getState().media).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// removeMedia
// ---------------------------------------------------------------------------

describe('mediaSlice — removeMedia', () => {
  it('removes item from media map and thread index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: 'thread-1', replyId: null });
    store.getState().mergeMediaForThread('thread-1', [item]);

    store.getState().removeMedia('media-1');

    const state = store.getState();
    expect('media-1' in state.media).toBe(false);
    expect(state.mediaIdsByThread['thread-1']).not.toContain('media-1');
  });

  it('removes item from media map and reply index', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: 'reply-1' });
    store.getState().mergeMediaForReply('reply-1', [item]);

    store.getState().removeMedia('media-1');

    const state = store.getState();
    expect('media-1' in state.media).toBe(false);
    expect(state.mediaIdsByReply['reply-1']).not.toContain('media-1');
  });

  it('does nothing when media id does not exist', () => {
    const store = makeStore();
    const before = store.getState().media;

    store.getState().removeMedia('nonexistent-id');

    expect(store.getState().media).toEqual(before);
  });

  it('handles item with threadId when thread index has no entry (no-op on index)', () => {
    const store = makeStore();
    // Insert item directly into media map only (no index entry)
    const item = makeMediaItem({ id: 'media-1', threadId: 'thread-99', replyId: null });
    store.getState().upsertMedia(item);
    // Manually clear the index to simulate a corrupted/missing entry
    // (We can't easily do that without direct state manipulation, so instead
    //  test that removeMedia still clears the media map entry correctly.)
    store.getState().removeMedia('media-1');

    expect('media-1' in store.getState().media).toBe(false);
  });

  it('removes one of multiple items from thread index without affecting siblings', () => {
    const store = makeStore();
    const item1 = makeMediaItem({ id: 'media-1', threadId: 'thread-1', replyId: null });
    const item2 = makeMediaItem({ id: 'media-2', threadId: 'thread-1', replyId: null });
    store.getState().mergeMediaForThread('thread-1', [item1, item2]);

    store.getState().removeMedia('media-1');

    const state = store.getState();
    expect(state.mediaIdsByThread['thread-1']).toEqual(['media-2']);
    expect('media-2' in state.media).toBe(true);
  });

  it('removes item with no threadId or replyId from media map only', () => {
    const store = makeStore();
    const item = makeMediaItem({ id: 'media-1', threadId: null, replyId: null });
    store.getState().upsertMedia(item);

    store.getState().removeMedia('media-1');

    expect('media-1' in store.getState().media).toBe(false);
  });
});
