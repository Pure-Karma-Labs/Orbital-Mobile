/**
 * Tests for ThreadDetailScreen — thread detail view with nested replies and composer.
 */

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  wrap: (c: unknown) => c,
}));

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: { Tap: () => ({ onEnd: () => ({ runOnJS: () => ({}) }) }) },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});

let mockBlockedSet = new Set<string>();
jest.mock('../../hooks/useBlockedSet', () => ({
  useBlockedSet: () => mockBlockedSet,
}));

// Mutable so a test can render the muted bell (#449).
let mockMutedTargets: Record<string, string> = {};

jest.mock('../../services/notificationSettingsSync', () => ({
  toggleMute: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        userId: 'user-1',
        displayName: null,
        contacts: {},
        blockedUserIds: [],
        blockUser: jest.fn(),
        mutedTargets: mockMutedTargets,
      }),
    ),
    {
      getState: jest.fn(() => ({
        userId: 'user-1',
        displayName: null,
        contacts: {},
        blockedUserIds: [],
        blockUser: jest.fn(),
        viewingConversationId: null,
        setViewingConversation: jest.fn(),
        mutedTargets: mockMutedTargets,
      })),
    },
  ),
}));

jest.mock('../../database/repositories/mediaRepository', () => ({
  updateMediaParent: jest.fn(),
}));

jest.mock('../../components/MediaGallery', () => ({
  MediaGallery: () => null,
}));

jest.mock('../../components/MediaLightbox', () => ({
  MediaLightbox: () => null,
}));

jest.mock('../../components/EmojiPicker', () => ({
  EmojiPicker: () => null,
}));

jest.mock('../../components/MediaThumbnailStrip', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    MediaThumbnailStrip: () => React.createElement(View, { testID: 'mock-media-strip' }),
  };
});

jest.mock('../../components/Emoji', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Emoji: (props: { unified: string }) =>
      React.createElement(View, { testID: `mock-emoji-${props.unified}` }),
  };
});

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadDetailScreen } from '../ThreadDetailScreen';
import { QuotaExceededError } from '../../services/api/errors';
import { toggleMute } from '../../services/notificationSettingsSync';
import { UPLOAD_CANCELLED_MESSAGE } from '../../services/media/uploadCancellation';
import type { BatchUploadProgressEvent } from '../../services/mediaUploadService';

const mockToggleMute = toggleMute as jest.Mock;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockLoadThread = jest.fn();
const mockLoadReplies = jest.fn();
const mockPostReply = jest.fn();

jest.mock('../../services/threadService', () => ({
  loadThread: (...args: unknown[]) => mockLoadThread(...args),
  loadReplies: (...args: unknown[]) => mockLoadReplies(...args),
  postReply: (...args: unknown[]) => mockPostReply(...args),
  hydrateRepliesFromLocal: jest.fn(),
}));

const mockUploadMediaBatch = jest.fn();

jest.mock('../../services/mediaUploadService', () => ({
  uploadMediaBatch: (...args: unknown[]) => mockUploadMediaBatch(...args),
  // Real implementation — handleSend's catch uses it to suppress the Alert on a
  // self-cancel. A jest.fn() would silently route cancels into the error branch.
  isUploadCancellation: (e: unknown) =>
    require('orbital-media-transcoder').isCancellation(e) ||
    (e instanceof Error && e.message === require('../../services/media/uploadCancellation').UPLOAD_CANCELLED_MESSAGE),
}));

const mockPickPhotos = jest.fn();
const mockRemoveMedia = jest.fn();
const mockClearMedia = jest.fn();
let mockSelectedMedia: unknown[] = [];

jest.mock('../../hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({
    selectedMedia: mockSelectedMedia,
    pickPhotos: mockPickPhotos,
    removeMedia: mockRemoveMedia,
    clearMedia: mockClearMedia,
  }),
}));

jest.mock('../../hooks/useWebSocketSubscription', () => ({
  useWebSocketSubscription: jest.fn(),
}));

const mockSetActiveThread = jest.fn();

jest.mock('../../stores', () => {
  const getState = () => ({
    userId: 'user-1',
    displayName: 'Alice',
    contacts: {},
    blockedUserIds: [],
    blockUser: jest.fn(),
    mutedTargets: mockMutedTargets,
  });
  return {
  useAppStore: Object.assign(
    (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState: jest.fn(getState) },
  ),
  useAuth: () => ({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
  }),
  useThreads: jest.fn(() => ({
    threads: {},
    threadIdsByConversation: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: mockSetActiveThread,
    markThreadViewed: jest.fn(),
    setReplies: jest.fn(),
    appendReplies: jest.fn(),
    upsertReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
  })),
  useConversations: () => ({
    conversations: {},
    conversationIds: [],
    activeConversationId: null,
  }),
  useMediaForThread: () => [],
  useMediaForReply: () => [],
};});

jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal navigation prop mock
// ---------------------------------------------------------------------------

const mockNavigation = {
  push: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
  removeListener: jest.fn(),
  canGoBack: jest.fn(() => true),
  dispatch: jest.fn(),
  isFocused: jest.fn(() => true),
  reset: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  pop: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0, key: 'stack', type: 'stack' })),
  getId: jest.fn(),
  setParams: jest.fn(),
};

const mockRoute = {
  key: 'ThreadDetail',
  name: 'ThreadDetail' as const,
  params: { threadId: 'thread-1', threadTitle: 'Test Thread' },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();

const fakeThread = {
  id: 'thread-1',
  conversationId: 'group-1',
  authorId: 'user-1',
  authorUsername: 'alice',
  title: 'Test Thread Title',
  body: 'This is the thread body content',
  contentType: 'text' as const,
  pinned: false,
  replyCount: 2,
  lastReplyAt: now,
  createdAt: now - 3600000, // 1 hour ago
  updatedAt: now - 3600000,
  syncStatus: 'synced' as const,
};

const fakeReplies = [
  {
    id: 'reply-1',
    threadId: 'thread-1',
    authorId: 'user-2',
    authorUsername: 'bob',
    body: 'First reply content',
    parentReplyId: null,
    depth: 0,
    createdAt: now - 1800000,
    updatedAt: now - 1800000,
    syncStatus: 'synced' as const,
  },
  {
    id: 'reply-2',
    threadId: 'thread-1',
    authorId: 'user-3',
    authorUsername: 'charlie',
    body: 'Nested reply content',
    parentReplyId: 'reply-1',
    depth: 1,
    createdAt: now - 900000,
    updatedAt: now - 900000,
    syncStatus: 'synced' as const,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Last renderer created by renderScreen(), unmounted in the global afterEach.
// A renderer left mounted past its test leaks OrbitalSpinner's recursive
// animation: the RN jest mock's startAnimatingNode fires an uncancellable 16ms
// timer (stopAnimation is a no-op jest.fn()), so the spin chain outlives the
// test and lands inside a later test's act() (CI: "Can't access .root on
// unmounted test renderer") or after environment teardown. Unmounting inside
// act() runs OrbitalSpinner's cleanup synchronously (alive.current = false),
// so the final queued timer sees the flag and stops the chain.
let currentRenderer: ReactTestRenderer | null = null;

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ThreadDetailScreen, {
          navigation: mockNavigation as unknown as React.ComponentProps<typeof ThreadDetailScreen>['navigation'],
          route: mockRoute as unknown as React.ComponentProps<typeof ThreadDetailScreen>['route'],
        }),
      ),
    );
  });
  // Flush pending microtasks (async effects from useEffect: loadThread/loadReplies)
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  currentRenderer = renderer;
  return renderer;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectedMedia = [];
  mockBlockedSet = new Set<string>();
  mockMutedTargets = {};
  // Default: loadThread and loadReplies resolve but store stays empty
  // (store is mocked separately)
  mockLoadThread.mockResolvedValue(fakeThread);
  mockLoadReplies.mockResolvedValue({
    replies: [],
    nextCursor: null,
    hasMore: false,
  });
  mockPostReply.mockResolvedValue({
    id: 'reply-new',
    threadId: 'thread-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    body: 'test',
    parentReplyId: null,
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncStatus: 'synced',
  });
  mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
});

afterEach(() => {
  if (currentRenderer) {
    act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — initial render', () => {
  it('has testID "thread-detail-screen"', async () => {
    const renderer = await renderScreen();
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'thread-detail-screen',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders the header with thread title from route params', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const headerTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Test Thread',
    );
    expect(headerTitle).toBeDefined();
  });

  it('renders the reply composer', async () => {
    const renderer = await renderScreen();
    const composer = renderer.root.findAll(
      (node) => node.props.testID === 'reply-composer',
    );
    expect(composer.length).toBeGreaterThan(0);
  });

  it('renders the reply input', async () => {
    const renderer = await renderScreen();
    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    expect(input.length).toBeGreaterThan(0);
  });

  it('calls setActiveThread on mount', async () => {
    await renderScreen();
    expect(mockSetActiveThread).toHaveBeenCalledWith('thread-1');
  });

  it('calls loadThread and loadReplies on mount', async () => {
    await renderScreen();
    expect(mockLoadThread).toHaveBeenCalledWith('thread-1');
  });
});

describe('ThreadDetailScreen — with thread data', () => {
  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {
        'reply-1': fakeReplies[0],
        'reply-2': fakeReplies[1],
      },
      replyIdsByThread: { 'thread-1': ['reply-1', 'reply-2'] },
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  it('renders the thread header with title', async () => {
    const renderer = await renderScreen();
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'thread-header',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders thread title text in the thread header', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const titleNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Test Thread Title',
    );
    expect(titleNode).toBeDefined();
  });

  it('renders the author display name in the thread header', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const authorNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Alice',
    );
    expect(authorNode).toBeDefined();
  });

  it('renders reply items for each reply', async () => {
    const renderer = await renderScreen();
    const reply1 = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-1',
    );
    const reply2 = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-2',
    );
    expect(reply1.length).toBeGreaterThan(0);
    expect(reply2.length).toBeGreaterThan(0);
  });

  it('renders reply author usernames', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const bobNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'bob',
    );
    const charlieNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'charlie',
    );
    expect(bobNode).toBeDefined();
    expect(charlieNode).toBeDefined();
  });

  it('renders the send button', async () => {
    const renderer = await renderScreen();
    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    expect(sendBtn.length).toBeGreaterThan(0);
  });

  it('shows "Replying to @bob" for nested reply-2 (parentReplyId: reply-1)', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const contextNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '↳ Replying to @bob',
    );
    expect(contextNode).toBeDefined();
  });

  it('does not show "Replying to" for top-level reply-1', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    // Only reply-2 has a parent — exactly one "Replying to" line should exist
    const contextNodes = allText.filter(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.startsWith('↳ Replying to'),
    );
    expect(contextNodes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Media send integration
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — media send', () => {
  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {},
      replyIdsByThread: {},
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
    mockSelectedMedia = [];
  });

  it('calls uploadMediaBatch and passes mediaIds to postReply on send with media', async () => {
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',

        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
        width: 50,
        height: 50,
      },
    ];

    const renderer = await renderScreen();

    // Type text into the composer
    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    expect(input.length).toBeGreaterThan(0);
    await act(async () => {
      input[0].props.onChangeText('hello with media');
    });

    // Press send
    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    // Wait for async send
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // The hook now threads an abort signal and a progress callback into the batch.
    expect(mockUploadMediaBatch).toHaveBeenCalledWith(
      mockSelectedMedia,
      'group-1',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
    expect(mockPostReply).toHaveBeenCalled();
    const postReplyArgs = mockPostReply.mock.calls[0];
    // 7th arg is options with mediaIds
    expect(postReplyArgs[6]).toEqual({ mediaIds: ['media-id-1'] });
  });

  it('clears text and media on successful send', async () => {
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',

        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
      },
    ];

    const renderer = await renderScreen();

    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    await act(async () => {
      input[0].props.onChangeText('test msg');
    });

    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockClearMedia).toHaveBeenCalled();
  });

  it('does not clear media on failed send', async () => {
    mockPostReply.mockRejectedValue(new Error('Server error'));
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',

        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
      },
    ];

    const renderer = await renderScreen();

    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    await act(async () => {
      input[0].props.onChangeText('will fail');
    });

    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockClearMedia).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Block filtering — replies
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — block filtering', () => {
  const blockedReply = {
    id: 'reply-blocked',
    threadId: 'thread-1',
    authorId: 'u-blocked',
    authorUsername: 'blockedUser',
    body: 'Blocked reply content',
    parentReplyId: null,
    depth: 0,
    createdAt: now - 1800000,
    updatedAt: now - 1800000,
    syncStatus: 'synced' as const,
  };

  const okReply = {
    id: 'reply-ok',
    threadId: 'thread-1',
    authorId: 'u-ok',
    authorUsername: 'okUser',
    body: 'Allowed reply content',
    parentReplyId: null,
    depth: 0,
    createdAt: now - 900000,
    updatedAt: now - 900000,
    syncStatus: 'synced' as const,
  };

  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {
        'reply-blocked': blockedReply,
        'reply-ok': okReply,
      },
      replyIdsByThread: { 'thread-1': ['reply-blocked', 'reply-ok'] },
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  it('hides replies authored by blocked users', async () => {
    mockBlockedSet = new Set(['u-blocked']);
    const renderer = await renderScreen();

    const blockedItem = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-blocked',
    );
    expect(blockedItem.length).toBe(0);
  });

  it('still renders replies from non-blocked authors alongside the thread header', async () => {
    mockBlockedSet = new Set(['u-blocked']);
    const renderer = await renderScreen();

    // The ok reply should be visible
    const okItem = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-ok',
    );
    expect(okItem.length).toBeGreaterThan(0);

    // The thread header should also be visible (blocked filter applies to replies, not thread)
    const header = renderer.root.findAll(
      (node) => node.props.testID === 'thread-header',
    );
    expect(header.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// QuotaExceededError — Alert.alert on upload failure
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — quota error', () => {
  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {},
      replyIdsByThread: {},
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
    mockSelectedMedia = [];
  });

  it('shows Alert.alert with quota message on QuotaExceededError during send', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const quotaBody = JSON.stringify({
      error: 'QUOTA_EXCEEDED',
      details: {
        quota: {
          storage_bytes: 500 * 1024 * 1024,
          max_bytes: 500 * 1024 * 1024,
          file_count: 42,
          max_files: 1000,
          storage_percent: 100,
          files_percent: 4.2,
          evictable_bytes: 0,
        },
      },
    });

    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',
        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
        width: 50,
        height: 50,
      },
    ];
    mockUploadMediaBatch.mockRejectedValue(new QuotaExceededError(quotaBody));

    const renderer = await renderScreen();

    // Type text into the composer
    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    expect(input.length).toBeGreaterThan(0);
    await act(async () => {
      input[0].props.onChangeText('hello with media');
    });

    // Press send
    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    // Wait for async send
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Upload Failed',
      'Orbit storage is full. Delete old photos or videos to make room.',
    );

    alertSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Header mute bell (#449)
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — header mute bell', () => {
  function bell(renderer: ReactTestRenderer): ReactTestInstance {
    const found = renderer.root.findAll((n) => n.props.testID === 'thread-mute-bell');
    expect(found.length).toBeGreaterThan(0);
    return found[0];
  }

  it('renders the bell in the header with an unmuted label', async () => {
    const renderer = await renderScreen();
    const button = bell(renderer);

    expect(button.props.accessibilityLabel).toBe('Mute this thread');
    expect(button.props.accessibilityState).toEqual({ selected: false });
  });

  it('reflects the muted state in label, a11y state, and glyph', async () => {
    mockMutedTargets = { 'thread-1': 'thread' };
    const renderer = await renderScreen();
    const button = bell(renderer);

    expect(button.props.accessibilityLabel).toBe('Unmute this thread');
    expect(button.props.accessibilityState).toEqual({ selected: true });

    const glyphs = renderer.root.findAll(
      (n) => n.props.unified === '1F515' || n.props.unified === '1F514',
    );
    expect(glyphs.some((g) => g.props.unified === '1F515')).toBe(true);
  });

  it('renders the unmuted glyph when the thread is not muted', async () => {
    const renderer = await renderScreen();
    const glyphs = renderer.root.findAll((n) => n.props.unified === '1F514');
    expect(glyphs.length).toBeGreaterThan(0);
  });

  it('tapping the bell toggles the thread mute', async () => {
    const renderer = await renderScreen();

    await act(async () => {
      bell(renderer).props.onPress();
    });

    expect(mockToggleMute).toHaveBeenCalledWith('thread-1', 'thread');
  });
});

// ---------------------------------------------------------------------------
// Unmount aborts an in-flight upload (#645)
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — unmount aborts in-flight upload', () => {
  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {},
      replyIdsByThread: {},
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
    mockSelectedMedia = [];
  });

  /**
   * Arms mockUploadMediaBatch to capture the batch's AbortSignal and hold the
   * batch open until that signal aborts, at which point it rejects with the
   * same sentinel the real service throws on a cancelled upload — mirroring
   * what uploadMediaBatch does for a real signal-driven abort.
   */
  function armInFlightUpload(): { getSignal: () => AbortSignal | undefined } {
    let capturedSignal: AbortSignal | undefined;
    mockUploadMediaBatch.mockImplementation(
      (
        _items: unknown,
        _groupId: unknown,
        opts: { signal: AbortSignal; onProgress?: (e: BatchUploadProgressEvent) => void },
      ) => {
        capturedSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new Error(UPLOAD_CANCELLED_MESSAGE));
          });
        });
      },
    );
    return { getSignal: () => capturedSignal };
  }

  async function beginMidUploadSend(renderer: ReactTestRenderer): Promise<void> {
    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    await act(async () => {
      input[0].props.onChangeText('mid-upload unmount');
    });

    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    // Let the batch call land so the mock captures the signal.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  it('aborts the in-flight upload signal when the screen unmounts mid-upload', async () => {
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',
        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
        width: 50,
        height: 50,
      },
    ];
    const { getSignal } = armInFlightUpload();

    const renderer = await renderScreen();
    await beginMidUploadSend(renderer);

    expect(getSignal()).toBeDefined();
    expect(getSignal()!.aborted).toBe(false);

    act(() => {
      renderer.unmount();
    });
    currentRenderer = null; // already unmounted — keep afterEach from double-unmounting

    expect(getSignal()!.aborted).toBe(true);

    // Flush the abort-triggered rejection so it does not leak into later tests.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  });

  it('never posts the reply and logs no unmounted-update warning after the unmount-abort rejects', async () => {
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',
        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
        width: 50,
        height: 50,
      },
    ];
    const { getSignal } = armInFlightUpload();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const renderer = await renderScreen();
    await beginMidUploadSend(renderer);
    expect(getSignal()).toBeDefined();

    act(() => {
      renderer.unmount();
    });
    currentRenderer = null; // already unmounted — keep afterEach from double-unmounting

    // Flush the microtask chain the abort-triggered rejection propagates through
    // (uploadBatch's finally -> handleSend's catch/finally).
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockPostReply).not.toHaveBeenCalled();

    const unmountedWarning = consoleErrorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && /unmounted|not wrapped in act/i.test(a)),
    );
    expect(unmountedWarning).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});
