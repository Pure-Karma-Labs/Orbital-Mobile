/**
 * Tests for mediaSlice.setMediaBatch — the batch hydration action
 * used by FileLibraryScreen to populate the store from DB rows.
 *
 * Key behavior: items in 'downloading' state must NOT be overwritten,
 * to prevent the abort/restart loop in useMediaDownload.
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

        // Auth slice stubs
        isAuthenticated: false,
        userId: null,
        username: null,
        displayName: null,
        avatarPath: null,
        avatarDigest: null,
        setUser: jest.fn(),
        clearAuth: jest.fn(),
        setAuthenticated: jest.fn(),
        updateProfile: jest.fn(),

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
      { name: 'setMediaBatch-test' },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mediaSlice — setMediaBatch', () => {
  it('inserts multiple items into the media map', () => {
    const store = makeStore();
    const items = [
      makeMediaItem({ id: 'media-1' }),
      makeMediaItem({ id: 'media-2' }),
      makeMediaItem({ id: 'media-3' }),
    ];
    store.getState().setMediaBatch(items);

    const state = store.getState();
    expect(Object.keys(state.media)).toHaveLength(3);
    expect(state.media['media-1'].id).toBe('media-1');
    expect(state.media['media-2'].id).toBe('media-2');
    expect(state.media['media-3'].id).toBe('media-3');
  });

  it('overwrites existing items that are NOT in downloading state', () => {
    const store = makeStore();
    const original = makeMediaItem({ id: 'media-1', downloadState: 'pending' });
    store.getState().upsertMedia(original);

    const updated = makeMediaItem({ id: 'media-1', downloadState: 'downloaded', localPath: '/local/img.jpg' });
    store.getState().setMediaBatch([updated]);

    const state = store.getState();
    expect(state.media['media-1'].downloadState).toBe('downloaded');
    expect(state.media['media-1'].localPath).toBe('/local/img.jpg');
  });

  it('does NOT overwrite items currently in downloading state', () => {
    const store = makeStore();
    // Set an item to 'downloading' — simulates an active download
    const downloading = makeMediaItem({ id: 'media-1', downloadState: 'downloading' });
    store.getState().upsertMedia(downloading);

    // Attempt to batch-overwrite it with 'pending' state (from DB)
    const dbRow = makeMediaItem({ id: 'media-1', downloadState: 'pending' });
    store.getState().setMediaBatch([dbRow]);

    // The 'downloading' state must be preserved
    expect(store.getState().media['media-1'].downloadState).toBe('downloading');
  });

  it('handles mixed batch — some downloading, some not', () => {
    const store = makeStore();
    // Pre-populate: media-1 is downloading, media-2 is pending
    store.getState().upsertMedia(makeMediaItem({ id: 'media-1', downloadState: 'downloading' }));
    store.getState().upsertMedia(makeMediaItem({ id: 'media-2', downloadState: 'pending' }));

    // Batch update both + a new item
    store.getState().setMediaBatch([
      makeMediaItem({ id: 'media-1', downloadState: 'pending', localPath: null }),
      makeMediaItem({ id: 'media-2', downloadState: 'downloaded', localPath: '/new.jpg' }),
      makeMediaItem({ id: 'media-3', downloadState: 'pending' }),
    ]);

    const state = store.getState();
    // media-1: protected (downloading)
    expect(state.media['media-1'].downloadState).toBe('downloading');
    // media-2: updated (was pending, not protected)
    expect(state.media['media-2'].downloadState).toBe('downloaded');
    // media-3: new insertion
    expect(state.media['media-3'].downloadState).toBe('pending');
  });

  it('handles empty batch without error', () => {
    const store = makeStore();
    store.getState().upsertMedia(makeMediaItem({ id: 'media-1' }));

    store.getState().setMediaBatch([]);

    // Existing item untouched
    expect(store.getState().media['media-1']).toBeDefined();
  });

  it('does not modify mediaIdsByThread or mediaIdsByReply indexes', () => {
    const store = makeStore();
    const items = [
      makeMediaItem({ id: 'media-1', threadId: 'thread-1' }),
      makeMediaItem({ id: 'media-2', replyId: 'reply-1' }),
    ];
    store.getState().setMediaBatch(items);

    // setMediaBatch only touches the flat media map, not the index maps
    const state = store.getState();
    expect(state.mediaIdsByThread).toEqual({});
    expect(state.mediaIdsByReply).toEqual({});
  });
});
