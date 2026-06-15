/**
 * Tests for ThreadsScreen — inbox screen with orbit bar, search, and thread list.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadsScreen } from '../ThreadsScreen';
import { getThreadState } from '../../utils/threadState';
import type { Thread } from '../../types/store';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  loadThreadsForGroup: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../services/conversationService', () => ({
  markConversationReadEverywhere: jest.fn(),
}));

jest.mock('../../hooks/useBlockedSet', () => ({
  useBlockedSet: () => new Set<string>(),
}));

jest.mock('../../hooks/useWebSocketSubscription', () => ({
  useWebSocketSubscription: jest.fn(),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => cb(), []);
  },
}));

jest.mock('../../hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    scrollY: { interpolate: () => 0 },
    scrollProps: {},
  }),
}));

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
}));

const mockSetViewingConversation = jest.fn();
const mockMarkConversationRead = jest.fn();

jest.mock('../../stores', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setViewingConversation: mockSetViewingConversation,
      markConversationRead: mockMarkConversationRead,
      conversations: {},
    })),
  },
  useAuth: () => ({
    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    avatarPath: null,
  }),
  useThreads: jest.fn(() => ({
    threads: {},
    threadIdsByConversation: {},
    threadLastViewedAt: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: jest.fn(),
    markThreadViewed: jest.fn(),
    setReplies: jest.fn(),
    upsertReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
  })),
  useConversations: () => ({
    conversations: {
      'group-1': {
        id: 'group-1',
        type: 'group',
        name: 'Family Orbit',
        memberCount: 3,
        active: true,
        muteUntil: null,
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    },
    conversationIds: ['group-1'],
    activeConversationId: 'group-1',
    setConversations: jest.fn(),
    setGroupConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
  }),
  useConnection: () => ({
    connectionStatus: 'connected',
    lastConnectedAt: null,
    reconnectAttempt: 0,
    setConnectionStatus: jest.fn(),
    setLastConnectedAt: jest.fn(),
    setReconnectAttempt: jest.fn(),
    clearTypingUsers: jest.fn(),
  }),
}));

// Mock @react-navigation/native-stack for navigation prop
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
  canGoBack: jest.fn(() => false),
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
  key: 'ThreadsList',
  name: 'ThreadsList' as const,
  params: undefined,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderThreadsScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ThreadsScreen, {
          navigation: mockNavigation as unknown as React.ComponentProps<typeof ThreadsScreen>['navigation'],
          route: mockRoute as unknown as React.ComponentProps<typeof ThreadsScreen>['route'],
        }),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThreadsScreen', () => {
  it('has testID "threads-screen"', () => {
    const renderer = renderThreadsScreen();
    const found = renderer.root.findAll((node) => node.props.testID === 'threads-screen');
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders the orbit bar with orbit name', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const orbitNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Family Orbit'),
    );
    expect(orbitNode).toBeDefined();
  });

  it('renders the search bar with placeholder', () => {
    const renderer = renderThreadsScreen();
    const inputs = renderer.root.findAllByType('TextInput' as unknown as React.ComponentType);
    const searchInput = inputs.find(
      (node) => node.props.placeholder === 'Search threads...',
    );
    expect(searchInput).toBeDefined();
  });

  it('renders the empty state when there are no threads', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    // Empty state contains "No threads yet"
    const emptyNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No threads yet'),
    );
    expect(emptyNode).toBeDefined();
  });
});

describe('ThreadsScreen — with thread data', () => {
  const now = Date.now();

  beforeEach(() => {
    // Override useThreads mock to return a thread
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {
        'thread-1': {
          id: 'thread-1',
          conversationId: 'group-1',
          authorId: 'user-1',
          authorUsername: 'alice',
          title: "Farmer's market on Saturday?",
          body: null,
          contentType: 'text',
          pinned: false,
          replyCount: 3,
          lastReplyAt: now,
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced',
        },
      },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      threadLastViewedAt: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: jest.fn(),
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
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
      setActiveThread: jest.fn(),
      markThreadViewed: jest.fn(),
      setReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  it('renders thread title when threads are present', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const titleNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === "Farmer's market on Saturday?",
    );
    expect(titleNode).toBeDefined();
  });

  it('renders Today day separator for current threads', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const dayNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '─── Today ───',
    );
    expect(dayNode).toBeDefined();
  });
});

describe('ThreadsScreen — focus lifecycle', () => {
  it('calls setViewingConversation and markConversationReadEverywhere on mount', () => {
    const { markConversationReadEverywhere } = jest.requireMock(
      '../../services/conversationService',
    ) as { markConversationReadEverywhere: jest.Mock };
    renderThreadsScreen();

    expect(mockSetViewingConversation).toHaveBeenCalledWith('group-1');
    expect(markConversationReadEverywhere).toHaveBeenCalledWith('group-1');
  });

  it('calls setViewingConversation(null) on unmount', () => {
    const renderer = renderThreadsScreen();

    mockSetViewingConversation.mockClear();
    act(() => {
      renderer.unmount();
    });

    expect(mockSetViewingConversation).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// getThreadState — per-thread unread rule (#329)
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    conversationId: 'group-1',
    authorId: 'user-1',
    title: 'Test thread',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: 10_000,
    updatedAt: 10_000,
    syncStatus: 'synced',
    ...overrides,
  } as Thread;
}

describe('getThreadState', () => {
  it('returns unread for a never-viewed thread with no watermark', () => {
    expect(getThreadState(makeThread(), {}, null)).toBe('unread');
  });

  it('returns read when the thread was viewed after its latest activity', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 12_000 });
    expect(getThreadState(thread, { 'thread-1': 13_000 }, null)).toBe('read');
  });

  it('returns unread when a reply arrives after the last view', () => {
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 20_000 });
    expect(getThreadState(thread, { 'thread-1': 15_000 }, null)).toBe('unread');
  });

  it('falls back to the conversation lastReadAt snapshot (reinstall case)', () => {
    // Never viewed locally, but the server watermark covers the activity
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 12_000 });
    expect(getThreadState(thread, {}, 13_000)).toBe('read');
  });

  it('uses the max of per-thread view and conversation snapshot', () => {
    // Snapshot is old, but the thread itself was viewed recently
    const thread = makeThread({ createdAt: 10_000, lastReplyAt: 20_000 });
    expect(getThreadState(thread, { 'thread-1': 25_000 }, 5_000)).toBe('read');
  });

  it('treats threads with no replies by createdAt alone', () => {
    const thread = makeThread({ createdAt: 30_000, lastReplyAt: null });
    expect(getThreadState(thread, {}, 25_000)).toBe('unread');
    expect(getThreadState(thread, {}, 35_000)).toBe('read');
  });
});
