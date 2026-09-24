/**
 * Tests for ThreadDetailScreen — thread detail view with nested replies and composer.
 */

// ---------------------------------------------------------------------------
// @react-navigation/native — useDiscardUploadGuard calls useNavigation() and
// usePreventRemove(). Without this mock, every render throws "Couldn't find a
// navigation object." The hook navigation uses the prop mockNavigation so that
// dispatch() calls from the guard are observable on the same mock.
// ---------------------------------------------------------------------------
const mockUsePreventRemove = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  usePreventRemove: (preventRemove: boolean, cb: unknown) =>
    mockUsePreventRemove(preventRemove, cb),
  useNavigation: () => mockNavigation,
}));

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
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

// Mutable so a test can make the thread's conversation a DM or an orbit (#745).
// Left empty by default: handleSend then reads undefined out of the map and the
// `dm` tag is omitted entirely.
let mockConversations: Record<string, { type: 'group' | 'direct' }> = {};

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
        conversations: mockConversations,
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
        conversations: mockConversations,
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
import * as Sentry from '@sentry/react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadDetailScreen } from '../ThreadDetailScreen';
import { ConflictError, NetworkError, QuotaExceededError, ServerError } from '../../services/api/errors';
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
//
// Assigned synchronously inside renderScreen's first act() callback rather than
// after the awaits (#731), so a test that exceeds the 5000 ms timeout mid-flush
// still leaves its renderer registered for teardown. Unmounting inside act()
// runs component cleanups synchronously, which is what stops any recursive
// Animated chain in the tree: the RN jest mock's startAnimatingNode fires an
// uncancellable 16 ms timer and stopAnimation is a no-op jest.fn(), so an
// `alive` ref flipped on unmount is the only brake.
//
// This does NOT contain the ~30-failure cascade that follows a timeout in CI
// ("Can't access .root on unmounted test renderer"). That was measured: force
// the first test to time out inside act and every later test still fails
// identically, whether this afterEach unmounts or is disabled entirely. Once a
// test is abandoned inside an async act(), React's act state is corrupted for
// the rest of the file and every subsequent create() yields an already
// unmounted root. The only lever the harness has is to not time out in the
// first place — see the warm-up in beforeAll below.
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
    // Register for teardown before the first await: see the note above.
    currentRenderer = renderer;
  });
  // Flush pending microtasks (async effects from useEffect: loadThread/loadReplies)
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function applyDefaultMocks(): void {
  jest.clearAllMocks();
  mockSelectedMedia = [];
  mockBlockedSet = new Set<string>();
  mockMutedTargets = {};
  mockConversations = {};
  // The guard mock has no implementation — clearAllMocks() above already resets
  // its call history. Explicitly clear in case a test overrides its behaviour.
  mockUsePreventRemove.mockReset();
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
}

// Pay the cold-render cost once, outside any test (#731). The first render of
// this screen used to cost ~20x a warm one (measured: 147 ms vs 7-15 ms
// locally; 9 ms with this warm-up in place), and under CI contention that
// margin is what pushed the suite's first test past the 5000 ms default —
// the trigger for every occurrence of this flake since 2026-07-22. It carries
// its own generous timeout so the per-test default stays 5000 ms and a genuine
// regression still fails loudly.
beforeAll(async () => {
  applyDefaultMocks();
  const renderer = await renderScreen();
  act(() => {
    renderer.unmount();
  });
  currentRenderer = null;
}, 15000);

beforeEach(() => {
  applyDefaultMocks();
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

  it('keeps the unsent guard off while postReply is in flight and arms it after a failure (PR #839 review)', async () => {
    let rejectReply: (e: Error) => void = () => {};
    mockPostReply.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectReply = reject; }),
    );
    mockSelectedMedia = [
      { uri: 'file:///photo1.jpg', type: 'image/jpeg', fileName: 'photo1.jpg', fileSize: 100 },
    ];

    const renderer = await renderScreen();
    const input = renderer.root.findAll((node) => node.props.testID === 'reply-input');
    await act(async () => {
      input[0].props.onChangeText('will fail');
    });
    const sendBtn = renderer.root.findAll((node) => node.props.testID === 'send-button');
    await act(async () => {
      sendBtn[0].props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // Upload landed, reply-create pending: the unabortable create is not guarded.
    expect(mockPostReply).toHaveBeenCalled();
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    await act(async () => {
      rejectReply(new Error('Server error'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // Failed with media still selected: the unsent arm is live.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
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

// ---------------------------------------------------------------------------
// Send failures — user-facing Alert (#612) + Sentry report (#738)
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — send failure signal', () => {
  const mockCaptureException = Sentry.captureException as unknown as jest.Mock;
  let alertSpy: jest.SpyInstance;

  function threadsState(): Record<string, unknown> {
    return {
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
    };
  }

  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue(threadsState());
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue({ ...threadsState(), threads: {}, threadIdsByConversation: {}, activeThreadId: null });
    alertSpy.mockRestore();
    mockSelectedMedia = [];
  });

  const oneImage = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  async function sendReply(): Promise<void> {
    const renderer = await renderScreen();
    const input = renderer.root.findAll((node) => node.props.testID === 'reply-input');
    await act(async () => {
      input[0].props.onChangeText('hello');
    });
    const sendBtn = renderer.root.findAll((node) => node.props.testID === 'send-button');
    await act(async () => {
      sendBtn[0].props.onPress();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Tags of the first Sentry capture. */
  function captureTags(): Record<string, string> {
    return (mockCaptureException.mock.calls[0][1] as { tags: Record<string, string> }).tags;
  }

  it('alerts and reports with the media-upload stage when the upload fails for a non-quota reason', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockRejectedValue(new NetworkError());

    await sendReply();

    expect(alertSpy).toHaveBeenCalledWith(
      'Reply Failed',
      'Failed to send your reply. Please try again.',
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(captureTags()).toMatchObject({
      feature: 'media-upload',
      stage: 'media-upload',
      surface: 'thread-reply',
    });
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  it('alerts and reports with the reply-create stage when postReply fails', async () => {
    // A typed ApiError reaches the catch intact since #747 stopped rewrapping
    // service errors, so status/api_code ride along with the stage.
    mockPostReply.mockRejectedValue(new ServerError(500));

    await sendReply();

    expect(alertSpy).toHaveBeenCalledWith(
      'Reply Failed',
      'Failed to send your reply. Please try again.',
    );
    expect(captureTags()).toMatchObject({
      stage: 'reply-create',
      surface: 'thread-reply',
      status: '500',
      api_code: 'SERVER_ERROR',
    });
    // Conversation absent from the store — the tag is omitted rather than
    // guessed, so dm:'false' always means "known orbit" (#745).
    expect(captureTags().dm).toBeUndefined();
  });

  it('tags an orbit reply failure with dm:false', async () => {
    mockConversations = { 'group-1': { type: 'group' } };
    mockPostReply.mockRejectedValue(new ServerError(500));

    await sendReply();

    expect(captureTags().dm).toBe('false');
  });

  it('tags a DM reply failure with dm:true', async () => {
    mockConversations = { 'group-1': { type: 'direct' } };
    mockPostReply.mockRejectedValue(new ServerError(500));

    await sendReply();

    expect(captureTags().dm).toBe('true');
  });

  it('captures but does not alert when postReply fails after the screen unmounted', async () => {
    // postReply is not abortable, so its rejection can land after the user
    // navigated away. Telemetry must still fire; the modal must not (it would
    // pop over an unrelated screen — panel finding, PR #744).
    let rejectPostReply!: (e: Error) => void;
    mockPostReply.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPostReply = reject;
        }),
    );

    const renderer = await renderScreen();
    const input = renderer.root.findAll((node) => node.props.testID === 'reply-input');
    await act(async () => {
      input[0].props.onChangeText('hello');
    });
    const sendBtn = renderer.root.findAll((node) => node.props.testID === 'send-button');
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    await act(async () => {
      renderer.unmount();
    });
    currentRenderer = null; // already unmounted — keep afterEach from double-unmounting

    await act(async () => {
      rejectPostReply(new Error('Server error'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(captureTags()).toMatchObject({ stage: 'reply-create', surface: 'thread-reply' });
  });

  it('keeps the quota path exactly as it was, reported at warning level', async () => {
    mockSelectedMedia = oneImage;
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
    mockUploadMediaBatch.mockRejectedValue(new QuotaExceededError(quotaBody));

    await sendReply();

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Upload Failed',
      'Orbit storage is full. Delete old photos or videos to make room.',
    );
    const context = mockCaptureException.mock.calls[0][1] as { level: string };
    expect(context.level).toBe('warning');
  });

  it('shows no alert and reports nothing when the user cancels the upload', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockRejectedValue(new Error(UPLOAD_CANCELLED_MESSAGE));

    await sendReply();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upload cache reuse (#749/#724)
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — upload cache reuse', () => {
  let alertSpy: jest.SpyInstance;

  const oneImage = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  function cacheThreadsState(extras: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
      ...extras,
    };
  }

  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue(cacheThreadsState());
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue({
      ...cacheThreadsState(),
      threads: {},
      threadIdsByConversation: {},
      activeThreadId: null,
    });
    alertSpy.mockRestore();
    mockSelectedMedia = [];
  });

  async function doSend(renderer: ReactTestRenderer): Promise<void> {
    const input = renderer.root.findAll((node) => node.props.testID === 'reply-input');
    await act(async () => {
      input[0].props.onChangeText('hello');
    });
    const sendBtn = renderer.root.findAll((node) => node.props.testID === 'send-button');
    await act(async () => {
      sendBtn[0].props.onPress();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  it('reuses uploaded media ids on a second send after a postReply failure', async () => {
    // mockSelectedMedia is a module-level array; useMediaPicker returns the same
    // reference on every render so array identity is stable — the cache hit
    // condition `cached.source === items` is satisfied on the second send.
    mockSelectedMedia = oneImage;
    mockPostReply
      .mockRejectedValueOnce(new Error('Server error'))
      .mockResolvedValueOnce({
        id: 'reply-new',
        threadId: 'thread-1',
        authorId: 'user-1',
        authorUsername: 'alice',
        body: 'hello',
        parentReplyId: null,
        depth: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        syncStatus: 'synced',
      });

    const renderer = await renderScreen();

    // First send — upload runs, postReply fails, cache is populated.
    await doSend(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    // Second send — same items reference, same groupId, same scopeKey (thread-1):
    // uploadBatch returns the cached ids without calling uploadMediaBatch again.
    await doSend(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    // Both postReply calls must carry the same mediaIds.
    const firstMediaArg = mockPostReply.mock.calls[0][6] as { mediaIds: string[] };
    const secondMediaArg = mockPostReply.mock.calls[1][6] as { mediaIds: string[] };
    expect(secondMediaArg).toEqual({ mediaIds: ['media-id-1'] });
    expect(secondMediaArg).toEqual(firstMediaArg);
  });

  it('alerts with the conflict copy and keeps the cache alive on a ConflictError (409)', async () => {
    mockSelectedMedia = oneImage;
    // 409 deliberately does NOT clear the cache — see useMediaUploadProgress —
    // so the second press re-attaches the same ids and draws another 409 rather
    // than uploading a duplicate set.
    mockPostReply.mockRejectedValue(new ConflictError());

    const renderer = await renderScreen();

    // First send: upload runs once, postReply throws ConflictError.
    await doSend(renderer);
    expect(alertSpy).toHaveBeenCalledWith(
      'Reply May Have Been Sent',
      'Your reply may already have been sent. Pull to refresh before sending again.',
    );
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    // Second send: cache entry is still alive → no re-upload.
    await doSend(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);
  });

  it('re-uploads when the threadId (scopeKey) changes after a failed send', async () => {
    // Set up both thread-1 and thread-2 in the store so handleSend can resolve
    // `thread` and proceed after the route is updated to thread-2.
    const fakeThread2 = { ...fakeThread, id: 'thread-2' };
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue(
      cacheThreadsState({
        threads: { 'thread-1': fakeThread, 'thread-2': fakeThread2 },
        threadIdsByConversation: { 'group-1': ['thread-1', 'thread-2'] },
        replyIdsByThread: { 'thread-1': [], 'thread-2': [] },
      }),
    );

    mockSelectedMedia = oneImage;
    mockPostReply
      .mockRejectedValueOnce(new Error('Server error'))
      .mockResolvedValueOnce({
        id: 'reply-new',
        threadId: 'thread-2',
        authorId: 'user-1',
        authorUsername: 'alice',
        body: 'hello',
        parentReplyId: null,
        depth: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        syncStatus: 'synced',
      });

    const renderer = await renderScreen(); // thread-1

    // First send on thread-1 — fails at postReply; cache populated with scopeKey='thread-1'.
    await doSend(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    // Update the route to thread-2 in-place. React reconciles the same component
    // type at the same position without remounting (no key change), so the hook
    // instance and its cacheRef survive. A new scopeKey ('thread-2') makes the
    // cache entry a miss on the next uploadBatch call.
    //
    // If ThreadDetailScreen or a navigator ancestor keys on threadId and DOES
    // remount on the update, the re-upload still happens — the hook instance is
    // fresh, the cache is empty, and uploadMediaBatch is called again. The
    // user-visible outcome (fresh upload on the new thread) is the same; only
    // the mechanism differs (no-cache vs. scopeKey miss).
    const thread2Route = {
      key: 'ThreadDetail',
      name: 'ThreadDetail' as const,
      params: { threadId: 'thread-2', threadTitle: 'Thread Two' },
    };
    await act(async () => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(ThreadDetailScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof ThreadDetailScreen>['navigation'],
            route: thread2Route as unknown as React.ComponentProps<typeof ThreadDetailScreen>['route'],
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // Second send on thread-2 — scopeKey mismatch (or remount) → re-upload.
    await doSend(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('fires exactly one Alert.alert on a postReply failure', async () => {
    mockPostReply.mockRejectedValue(new Error('Server error'));

    const renderer = await renderScreen();
    await doSend(renderer);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Reply Failed',
      'Failed to send your reply. Please try again.',
    );
  });
});
