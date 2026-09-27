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

// Backs useAppStore.getState().replyIdsByThread — the screen snapshots this at
// the start of every pagination pass to build the reconcile candidate set.
let mockStoreReplyIds: Record<string, string[]> = {};
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
        // Read live: a test can mutate this mid-pass to simulate a WebSocket
        // reply landing between the pass start and its terminal page.
        replyIdsByThread: mockStoreReplyIds,
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
import {
  ConflictError,
  NetworkError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from '../../services/api/errors';
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
const mockReconcileThreadReplies = jest.fn();

jest.mock('../../services/threadService', () => ({
  loadThread: (...args: unknown[]) => mockLoadThread(...args),
  loadReplies: (...args: unknown[]) => mockLoadReplies(...args),
  postReply: (...args: unknown[]) => mockPostReply(...args),
  reconcileThreadReplies: (...args: unknown[]) => mockReconcileThreadReplies(...args),
  hydrateRepliesFromLocal: jest.fn(),
}));

const mockUploadMediaBatch = jest.fn();
/**
 * The REAL useMediaUploadProgress runs in this suite, so its #724b rollback
 * seam has to exist in the factory: an omitted export is handed to the hook as
 * `undefined`, and the fire-and-forget `.catch` would swallow the TypeError,
 * making every rollback assertion vacuously pass.
 */
const mockRollbackUploadedMedia = jest.fn();

jest.mock('../../services/mediaUploadService', () => ({
  uploadMediaBatch: (...args: unknown[]) => mockUploadMediaBatch(...args),
  rollbackUploadedMedia: (...args: unknown[]) => mockRollbackUploadedMedia(...args),
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
  mockStoreReplyIds = {};
  mockMutedTargets = {};
  mockConversations = {};
  // The guard mock has no implementation — clearAllMocks() above already resets
  // its call history. Explicitly clear in case a test overrides its behaviour.
  mockUsePreventRemove.mockReset();
  // Default: loadThread and loadReplies resolve but store stays empty
  // (store is mocked separately)
  mockLoadThread.mockResolvedValue(fakeThread);
  // #821 shape: offsets and the reconcile keep-set are driven by the RAW
  // server rows, so every stub has to carry rawCount/serverIds/newIdCount.
  mockLoadReplies.mockResolvedValue({
    replies: [],
    rawCount: 0,
    serverIds: [],
    newIdCount: 0,
    hasMore: false,
  });
  mockReconcileThreadReplies.mockReturnValue([]);
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

  it('sets the composer reply target when a reply row\'s arrow is pressed (#518)', async () => {
    const renderer = await renderScreen();

    // No reply context before any press.
    expect(
      renderer.root.findAll((node) => node.props.testID === 'reply-context'),
    ).toHaveLength(0);

    const arrow = renderer.root
      .findAll((node) => node.props.testID === 'reply-item-reply-1-reply-button')
      .find((node) => typeof node.props.onPress === 'function');
    expect(arrow).toBeDefined();

    await act(async () => {
      arrow!.props.onPress();
    });

    const context = renderer.root.findAll(
      (node) => node.props.testID === 'reply-context',
    );
    expect(context.length).toBeGreaterThan(0);

    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const contextLabel = allText.find(
      (node) =>
        Array.isArray(node.props.children) &&
        node.props.children.join('') === 'Replying to @bob',
    );
    expect(contextLabel).toBeDefined();
  });

  it('hands ReplyComposer a FRESH replyTarget object on every arrow press (#518 re-focus)', async () => {
    const renderer = await renderScreen();

    const findComposerTarget = (): unknown => {
      const composers = renderer.root.findAll(
        (node) =>
          node.props != null &&
          'replyTarget' in node.props &&
          typeof node.props.onClearReplyTarget === 'function',
      );
      expect(composers.length).toBeGreaterThan(0);
      return composers[0].props.replyTarget;
    };

    const pressArrow = async (): Promise<void> => {
      const arrow = renderer.root
        .findAll((node) => node.props.testID === 'reply-item-reply-1-reply-button')
        .find((node) => typeof node.props.onPress === 'function');
      expect(arrow).toBeDefined();
      await act(async () => {
        arrow!.props.onPress();
      });
    };

    await pressArrow();
    const first = findComposerTarget();
    await pressArrow();
    const second = findComposerTarget();

    // Same reply, but a NEW object each time — ReplyComposer's focus effect
    // keys on identity, so memoizing this would kill re-focus.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
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

    // A create-stage 5xx may have committed before the handler failed, so the
    // copy is the "may have been sent" one, not the generic failure (#840).
    expect(alertSpy).toHaveBeenCalledWith(
      'Reply May Have Been Sent',
      'Your reply may already have been sent. Pull to refresh before sending again.',
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
    // A 409 deliberately does NOT drop the cache — see releaseUploadCache's
    // 'may-be-attached' arm — so the second press re-attaches the same ids and
    // draws another 409 rather than uploading a duplicate set.
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

  // -------------------------------------------------------------------------
  // Uploaded-media rollback (#724b)
  // -------------------------------------------------------------------------

  /** Drive the discard guard: trigger the prevented-remove callback, press Discard. */
  async function confirmDiscard(): Promise<void> {
    const onPrevented = mockUsePreventRemove.mock.calls.at(-1)?.[1] as (
      e: { data: { action: unknown } },
    ) => void;
    act(() => {
      onPrevented({ data: { action: { type: 'POP' } } });
    });
    const discardCall = alertSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('Discard'),
    );
    const buttons = discardCall?.[2] as { text: string; onPress?: () => void }[];
    const discard = buttons.find((b) => b.text === 'Discard');
    await act(async () => {
      discard?.onPress?.();
      // The rollback is scheduled on a microtask.
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('rolls the held media ids back when the user confirms Discard', async () => {
    mockSelectedMedia = oneImage;
    // 400 is a definitely-not-committed failure, so the cache stays
    // rollback-eligible.
    mockPostReply.mockRejectedValue(new ValidationError(400));

    const renderer = await renderScreen();
    await doSend(renderer);
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);

    await confirmDiscard();

    expect(mockRollbackUploadedMedia).toHaveBeenCalledWith(['media-id-1']);
  });

  it('rolls nothing back on a successful send', async () => {
    mockSelectedMedia = oneImage;
    mockPostReply.mockResolvedValue({
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
    await doSend(renderer);

    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('after a 409 leaves the guard disarmed and never rolls the ids back', async () => {
    mockSelectedMedia = oneImage;
    mockPostReply.mockRejectedValue(new ConflictError());

    const renderer = await renderScreen();
    await doSend(renderer);

    // The reply probably committed, so Back must navigate with no prompt.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    await confirmDiscard();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('after a create-stage network failure KEEPS the guard armed but still rolls nothing back', async () => {
    mockSelectedMedia = oneImage;
    mockPostReply.mockRejectedValue(new NetworkError());

    const renderer = await renderScreen();
    await doSend(renderer);

    // Unlike a 409, a network failure leaves it genuinely unknown whether the
    // reply exists, so the user may still be holding unattached media: the
    // "Discard unsent reply?" prompt has to survive (Alex, PR #840 review).
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    // ...but the ids are flagged, so discarding must not delete media that may
    // be on a reply.
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('shows the "may have been sent" alert for a network failure, not just a 409', async () => {
    mockSelectedMedia = oneImage;
    mockPostReply.mockRejectedValue(new NetworkError());

    const renderer = await renderScreen();
    await doSend(renderer);

    expect(alertSpy).toHaveBeenCalledWith(
      'Reply May Have Been Sent',
      'Your reply may already have been sent. Pull to refresh before sending again.',
    );
  });

  it('keeps the generic alert, and the rollback, when the failure provably never committed', async () => {
    mockSelectedMedia = oneImage;
    // neverSent: the rate-limit backoff abort never issued the request, so
    // nothing can have been sent and the media stays rollback-eligible.
    mockPostReply.mockRejectedValue(
      new NetworkError('Request aborted during rate-limit backoff', true),
    );

    const renderer = await renderScreen();
    await doSend(renderer);

    expect(alertSpy).toHaveBeenCalledWith(
      'Reply Failed',
      'Failed to send your reply. Please try again.',
    );
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).toHaveBeenCalledWith(['media-id-1']);
  });
});

// ---------------------------------------------------------------------------
// Tree order + pagination (#821)
// ---------------------------------------------------------------------------

/** Store-shaped useThreads mock with an explicit reply set. */
function mockThreadsStore(
  replies: Record<string, (typeof fakeReplies)[number]>,
  ids: string[],
): void {
  const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
  storesMock.useThreads.mockReturnValue({
    threads: { 'thread-1': fakeThread },
    threadIdsByConversation: { 'group-1': ['thread-1'] },
    replies,
    replyIdsByThread: { 'thread-1': ids },
    activeThreadId: 'thread-1',
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: mockSetActiveThread,
    markThreadViewed: jest.fn(),
    setReplies: jest.fn(),
    appendReplies: jest.fn(),
    upsertReply: jest.fn(),
    replaceReply: jest.fn(),
    reconcileReplies: jest.fn(() => []),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
  });
}

function resetThreadsStore(): void {
  const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
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
    replaceReply: jest.fn(),
    reconcileReplies: jest.fn(() => []),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
  });
}

function makeReply(
  id: string,
  parentReplyId: string | null,
  createdAt: number,
  authorId = 'user-2',
): (typeof fakeReplies)[number] {
  return {
    id,
    threadId: 'thread-1',
    authorId,
    authorUsername: authorId,
    body: `body of ${id}`,
    parentReplyId,
    // Deliberately wrong: the screen must take depth from the tree, never here.
    depth: 9,
    createdAt,
    updatedAt: createdAt,
    syncStatus: 'synced' as const,
  };
}

/** The reply rows the FlatList was actually handed, in render order. */
function listData(renderer: ReactTestRenderer): Array<{
  reply: { id: string };
  depth: number;
  parentState: string;
}> {
  const list = renderer.root.find(
    (n) => Array.isArray(n.props.data) && typeof n.props.onEndReached === 'function',
  );
  return list.props.data;
}

function flatList(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(
    (n) => Array.isArray(n.props.data) && typeof n.props.onEndReached === 'function',
  );
}

function page(over: Partial<{
  replies: unknown[];
  rawCount: number;
  serverIds: string[];
  newIdCount: number;
  hasMore: boolean;
}>) {
  return {
    replies: [],
    rawCount: 0,
    serverIds: [],
    newIdCount: 0,
    hasMore: false,
    ...over,
  };
}

describe('ThreadDetailScreen — tree order (#821)', () => {
  afterEach(resetThreadsStore);

  it('renders store order A, B, A1 as A, A1, B with tree depths', async () => {
    // Exactly the #821 shape: the confirmed nested reply was appended last.
    mockThreadsStore(
      {
        A: makeReply('A', null, now - 3000),
        B: makeReply('B', null, now - 2000),
        A1: makeReply('A1', 'A', now - 1000),
      },
      ['A', 'B', 'A1'],
    );

    const renderer = await renderScreen();

    expect(listData(renderer)).toHaveLength(3);
    expect(listData(renderer).map((r) => [r.reply.id, r.depth])).toEqual([
      ['A', 0],
      ['A1', 1],
      ['B', 0],
    ]);

    // ...and the rendered rows follow that order, not the store's.
    // Host nodes only: a testID also shows up on the composite wrappers above it.
    const rendered = renderer.root
      .findAll(
        (n) =>
          typeof n.type === 'string' &&
          typeof n.props.testID === 'string' &&
          /^reply-item-[A-Z0-9]+$/.test(n.props.testID),
      )
      .map((n) => n.props.testID as string);
    expect(rendered.slice(0, 3)).toEqual([
      'reply-item-A',
      'reply-item-A1',
      'reply-item-B',
    ]);
  });

  it('renders a blocked parent\'s child with "a hidden reply"', async () => {
    mockBlockedSet = new Set(['u-blocked']);
    mockThreadsStore(
      {
        A: makeReply('A', null, now - 3000),
        H: makeReply('H', 'A', now - 2000, 'u-blocked'),
        C: makeReply('C', 'H', now - 1000),
      },
      ['A', 'H', 'C'],
    );

    const renderer = await renderScreen();

    expect(listData(renderer).map((r) => [r.reply.id, r.parentState])).toEqual([
      ['A', 'none'],
      ['C', 'hidden'],
    ]);

    const context = renderer.root.findAll(
      (n) => n.props.testID === 'reply-item-C-parent-context',
    );
    expect(context.length).toBeGreaterThan(0);
    expect(context[0].props.children).toBe('↳ Replying to a hidden reply');

    // The blocked author's name must not survive anywhere in the tree.
    expect(
      renderer.root.findAll(
        (n) => typeof n.props.children === 'string' && n.props.children.includes('u-blocked'),
      ),
    ).toHaveLength(0);
  });

  it('renders a reply whose parent is not loaded with "an earlier reply"', async () => {
    mockThreadsStore(
      { X: makeReply('X', 'parent-on-another-page', now - 1000) },
      ['X'],
    );

    const renderer = await renderScreen();

    expect(listData(renderer).map((r) => r.parentState)).toEqual(['orphan']);
    const context = renderer.root.findAll(
      (n) => n.props.testID === 'reply-item-X-parent-context',
    );
    expect(context[0].props.children).toBe('↳ Replying to an earlier reply');
  });
});

describe('ThreadDetailScreen — pagination (#821)', () => {
  afterEach(resetThreadsStore);

  beforeEach(() => {
    mockThreadsStore({ A: makeReply('A', null, now - 3000) }, ['A']);
  });

  it('advances the offset by rawCount, not by the decrypted row count', async () => {
    // Page 1: 3 server rows, only 2 decrypted. Counting decrypted rows would
    // ask for offset 2 and silently re-serve (then skip) a reply.
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 3, serverIds: ['s1', 's2', 's3'], newIdCount: 2, hasMore: true }),
    );
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 1, serverIds: ['s4'], newIdCount: 1, hasMore: false }),
    );

    const renderer = await renderScreen();
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });

    expect(mockLoadReplies).toHaveBeenNthCalledWith(1, 'thread-1', 'group-1');
    expect(mockLoadReplies).toHaveBeenNthCalledWith(2, 'thread-1', 'group-1', 3);
  });

  it('fetches the next page immediately when a page adds no new rows', async () => {
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 2, hasMore: true }),
    );
    // A page of rows the store already has: content length does not change, so
    // onEndReached will never fire again on its own.
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 0, hasMore: true }),
    );
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 2, serverIds: ['s5', 's6'], newIdCount: 2, hasMore: true }),
    );

    const renderer = await renderScreen();
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });

    // 1 initial + the stalled page + its follow-up.
    expect(mockLoadReplies).toHaveBeenCalledTimes(3);
    expect(mockLoadReplies).toHaveBeenNthCalledWith(3, 'thread-1', 'group-1', 4);
  });

  it('stops paging and reconciles when the server reports no more rows', async () => {
    mockStoreReplyIds = { 'thread-1': ['s1', 'gone-1'] };
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 2, hasMore: false }),
    );

    await renderScreen();

    expect(mockReconcileThreadReplies).toHaveBeenCalledTimes(1);
    const [threadIdArg, keepIds, candidateIds] = mockReconcileThreadReplies.mock.calls[0];
    expect(threadIdArg).toBe('thread-1');
    expect([...(keepIds as Set<string>)]).toEqual(['s1', 's2']);
    // Candidates are the ids that existed when the pass began.
    expect([...(candidateIds as Set<string>)].sort()).toEqual(['gone-1', 's1']);
  });

  it('never offers a mid-pass arrival as a deletion candidate (#821 review)', async () => {
    mockStoreReplyIds = { 'thread-1': ['old-1'] };
    mockLoadReplies.mockImplementationOnce(async () => {
      // A WebSocket reply (or the user's own confirmed send) lands after the
      // pass captured its candidate snapshot but before the page resolves.
      mockStoreReplyIds = { 'thread-1': ['old-1', 'ws-1'] };
      return page({ rawCount: 1, serverIds: ['s1'], newIdCount: 1, hasMore: false });
    });

    await renderScreen();

    expect(mockReconcileThreadReplies).toHaveBeenCalledTimes(1);
    const candidateIds = mockReconcileThreadReplies.mock.calls[0][2] as Set<string>;
    expect([...candidateIds]).toEqual(['old-1']);
    expect(candidateIds.has('ws-1')).toBe(false);
  });

  it('stops paging when a page comes back empty even though hasMore is true', async () => {
    mockLoadReplies.mockResolvedValueOnce(
      page({ rawCount: 0, serverIds: [], newIdCount: 0, hasMore: true }),
    );

    const renderer = await renderScreen();
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });

    expect(mockLoadReplies).toHaveBeenCalledTimes(1);
  });

  it('keeps the offset high-water mark across a refresh', async () => {
    mockLoadReplies
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 2, hasMore: true }),
      )
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s3', 's4'], newIdCount: 2, hasMore: true }),
      )
      // Refresh — page 1 again.
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 0, hasMore: true }),
      )
      .mockResolvedValueOnce(
        page({ rawCount: 1, serverIds: ['s5'], newIdCount: 1, hasMore: false }),
      );

    const renderer = await renderScreen();
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });
    expect(mockLoadReplies).toHaveBeenNthCalledWith(2, 'thread-1', 'group-1', 2);

    await act(async () => {
      await flatList(renderer).props.refreshControl.props.onRefresh();
    });
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });

    // Not 2: the refresh must not rewind past the pages already loaded.
    expect(mockLoadReplies).toHaveBeenNthCalledWith(4, 'thread-1', 'group-1', 4);
  });

  it('does not reconcile after a pass that skipped a page (the refresh jump)', async () => {
    mockLoadReplies
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 2, hasMore: true }),
      )
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s3', 's4'], newIdCount: 2, hasMore: true }),
      )
      .mockResolvedValueOnce(
        page({ rawCount: 2, serverIds: ['s1', 's2'], newIdCount: 0, hasMore: true }),
      )
      // Fetched at the high-water offset: rows 2-3 were never seen in THIS
      // pass, so its id set is incomplete and must not drive a delete.
      .mockResolvedValueOnce(
        page({ rawCount: 0, serverIds: [], newIdCount: 0, hasMore: false }),
      );

    const renderer = await renderScreen();
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });
    mockReconcileThreadReplies.mockClear();

    await act(async () => {
      await flatList(renderer).props.refreshControl.props.onRefresh();
    });
    await act(async () => {
      await flatList(renderer).props.onEndReached();
    });

    expect(mockReconcileThreadReplies).not.toHaveBeenCalled();
  });

  it('sets NO maintainVisibleContentPosition (it would scroll the OP away)', async () => {
    // RN 0.82.1's VirtualizedList adds +1 to minIndexForVisible when a
    // ListHeaderComponent exists, so even minIndexForVisible: 0 anchors on the
    // first reply rather than offset 0. ThreadHeader grows after first layout
    // (LinkPreviewCard/MediaGallery), which then pushes the original post off
    // screen on open. Deferred to a device-verified change (#821 PR review).
    const renderer = await renderScreen();
    expect(flatList(renderer).props.maintainVisibleContentPosition).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Jump, collapse and post-send landing (#821 PR2)
//
// REAL TIMERS, like the rest of this file: renderScreen's flush helper awaits a
// setTimeout(0), so fake timers deadlock it. That means the 2s highlight clear
// and the 3s focus windows are never reached here — they belong to
// useReplyFocus.test.tsx, which owns the timing contract.
// ---------------------------------------------------------------------------

/** Spy on the imperative scroll the focus hook drives through the list ref. */
function spyOnScrollToIndex(): jest.SpyInstance {
  const { FlatList } = require('react-native');
  return jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
}

/** The pressable node for a testID (TouchableOpacity spreads props downward). */
function pressable(renderer: ReactTestRenderer, testID: string): ReactTestInstance {
  const tagged = renderer.root.findAll((n) => n.props.testID === testID, { deep: true });
  const pressables = tagged.filter((n) => typeof n.props.onPress === 'function');
  expect(pressables.length).toBeGreaterThan(0);
  return pressables[0];
}

describe('ThreadDetailScreen — jump to parent (#821)', () => {
  afterEach(resetThreadsStore);

  it("scrolls to the parent's CURRENT index when the context line is pressed", async () => {
    const scrollToIndex = spyOnScrollToIndex();
    try {
      // Rows render as A, A1, B — so A sits at index 0 and A1's jump must
      // target 0, not the store position of its parent.
      mockThreadsStore(
        {
          A: makeReply('A', null, now - 3000),
          B: makeReply('B', null, now - 2000),
          A1: makeReply('A1', 'A', now - 1000),
        },
        ['A', 'B', 'A1'],
      );
      const renderer = await renderScreen();
      expect(listData(renderer).map((r) => r.reply.id)).toEqual(['A', 'A1', 'B']);

      scrollToIndex.mockClear();
      await act(async () => {
        pressable(renderer, 'reply-item-A1-parent-jump').props.onPress();
      });

      expect(scrollToIndex).toHaveBeenCalledWith(
        expect.objectContaining({ index: 0, viewPosition: 0.3 }),
      );
      // ...and the parent is highlighted, via the primitive extraData key.
      expect(flatList(renderer).props.extraData).toBe('A|');
    } finally {
      scrollToIndex.mockRestore();
    }
  });

  it('offers no jump control on an orphan row — there is nowhere to go', async () => {
    mockThreadsStore({ X: makeReply('X', 'unloaded-parent', now - 1000) }, ['X']);
    const renderer = await renderScreen();
    expect(
      renderer.root.findAll((n) => n.props.testID === 'reply-item-X-parent-jump'),
    ).toHaveLength(0);
  });
});

describe('ThreadDetailScreen — collapse (#821)', () => {
  afterEach(resetThreadsStore);

  it('hides the subtree and switches the toggle to "[+] N"', async () => {
    mockThreadsStore(
      {
        A: makeReply('A', null, now - 4000),
        A1: makeReply('A1', 'A', now - 3000),
        A2: makeReply('A2', 'A1', now - 2000),
        B: makeReply('B', null, now - 1000),
      },
      ['A', 'A1', 'A2', 'B'],
    );
    const renderer = await renderScreen();
    expect(listData(renderer).map((r) => r.reply.id)).toEqual(['A', 'A1', 'A2', 'B']);

    await act(async () => {
      pressable(renderer, 'reply-item-A-collapse-toggle').props.onPress();
    });

    // The whole contiguous subtree goes, and the siblings stay.
    expect(listData(renderer).map((r) => r.reply.id)).toEqual(['A', 'B']);
    const toggle = pressable(renderer, 'reply-item-A-collapse-toggle');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle.props.accessibilityLabel).toBe('Show 2 replies to user-2');
    expect(flatList(renderer).props.extraData).toBe('|A');

    // ...and expanding again restores them.
    await act(async () => {
      pressable(renderer, 'reply-item-A-collapse-toggle').props.onPress();
    });
    expect(listData(renderer).map((r) => r.reply.id)).toEqual(['A', 'A1', 'A2', 'B']);
    expect(flatList(renderer).props.extraData).toBe('|');
  });

  it('offers no toggle on a leaf row', async () => {
    mockThreadsStore({ A: makeReply('A', null, now - 1000) }, ['A']);
    const renderer = await renderScreen();
    expect(
      renderer.root.findAll((n) => n.props.testID === 'reply-item-A-collapse-toggle'),
    ).toHaveLength(0);
  });
});

describe('ThreadDetailScreen — landing after send (#821)', () => {
  afterEach(resetThreadsStore);

  it('focuses the CONFIRMED reply id once the row is in the list', async () => {
    const scrollToIndex = spyOnScrollToIndex();
    try {
      // The store already carries the confirmed row (postReply resolves with
      // 'reply-new', and the real service inserts it before returning).
      mockThreadsStore(
        {
          A: makeReply('A', null, now - 3000),
          'reply-new': makeReply('reply-new', null, now - 1000, 'user-1'),
        },
        ['A', 'reply-new'],
      );
      const renderer = await renderScreen();
      scrollToIndex.mockClear();

      const input = renderer.root.findAll((n) => n.props.testID === 'reply-input');
      await act(async () => {
        input[0].props.onChangeText('hello');
      });
      const sendBtn = renderer.root.findAll((n) => n.props.testID === 'send-button');
      await act(async () => {
        sendBtn[0].props.onPress();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(mockPostReply).toHaveBeenCalled();
      expect(scrollToIndex).toHaveBeenCalledWith(
        expect.objectContaining({ index: 1, viewPosition: 0.3 }),
      );
      expect(flatList(renderer).props.extraData).toBe('reply-new|');
    } finally {
      scrollToIndex.mockRestore();
    }
  });

  it('requests no landing when the send fails', async () => {
    const scrollToIndex = spyOnScrollToIndex();
    try {
      mockThreadsStore({ A: makeReply('A', null, now - 3000) }, ['A']);
      mockPostReply.mockRejectedValueOnce(new ValidationError(400, 'nope'));
      const renderer = await renderScreen();
      scrollToIndex.mockClear();

      const input = renderer.root.findAll((n) => n.props.testID === 'reply-input');
      await act(async () => {
        input[0].props.onChangeText('hello');
      });
      const sendBtn = renderer.root.findAll((n) => n.props.testID === 'send-button');
      await act(async () => {
        sendBtn[0].props.onPress();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(flatList(renderer).props.extraData).toBe('|');
    } finally {
      scrollToIndex.mockRestore();
    }
  });
});
