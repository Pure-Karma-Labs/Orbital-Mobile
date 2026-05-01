/**
 * Tests for ThreadsScreen — inbox screen with orbit bar, search, and thread list.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadsScreen } from '../ThreadsScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  loadThreadsForGroup: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    scrollY: { interpolate: () => 0 },
    scrollProps: {},
  }),
}));

jest.mock('../../stores', () => ({
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
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: jest.fn(),
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
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
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

  it('renders the search bar placeholder', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const searchNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Search threads...',
    );
    expect(searchNode).toBeDefined();
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
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: jest.fn(),
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
