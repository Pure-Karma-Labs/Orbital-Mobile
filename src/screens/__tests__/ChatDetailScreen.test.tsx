/**
 * Tests for ChatDetailScreen — thread list in a DM, empty state, data loading, and navigation.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ChatDetailScreen } from '../ChatDetailScreen';
import type { Thread } from '../../types/store';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: { Tap: () => ({ onEnd: () => ({ runOnJS: () => ({}) }) }) },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});

jest.mock('../../services/threadService', () => ({
  loadThreadsForGroup: jest.fn().mockResolvedValue([]),
  hydrateThreadsFromLocal: jest.fn(),
}));

jest.mock('../../services/conversationService', () => ({
  markConversationReadEverywhere: jest.fn(),
}));

let mockBlockedSet = new Set<string>();
jest.mock('../../hooks/useBlockedSet', () => ({
  useBlockedSet: () => mockBlockedSet,
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

const mockSetViewingConversation = jest.fn();
const mockMarkConversationRead = jest.fn();

jest.mock('../../stores/useAppStore', () => {
  const state = {
    setViewingConversation: mockSetViewingConversation,
    markConversationRead: mockMarkConversationRead,
    conversations: {},
    userId: null,
    displayName: null,
    contacts: {},
  };
  return {
    useAppStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: jest.fn(() => state) },
    ),
  };
});

jest.mock('../../hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    scrollY: { interpolate: () => 0 },
    scrollProps: {},
  }),
}));

jest.mock('../../components/PullToRefreshOverlay', () => ({
  PullToRefreshOverlay: () => null,
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

let mockSearchState = {
  searchText: '',
  setSearchText: jest.fn(),
  resultThreadIds: [] as string[],
  isSearching: false,
  clearSearch: jest.fn(),
};
jest.mock('../../hooks/useSQLiteSearch', () => ({
  useSQLiteSearch: () => mockSearchState,
}));

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
}));

const mockUseThreads = jest.fn();

jest.mock('../../stores', () => ({
  useThreads: (...args: unknown[]) => mockUseThreads(...args),
  useAuth: () => ({ userId: 'test-user-id', username: 'testuser' }),
  useContactForConversation: () => null,
  useAppStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({
      setViewingConversation: mockSetViewingConversation,
      markConversationRead: mockMarkConversationRead,
      conversations: {},
      userId: null,
      displayName: null,
      contacts: {},
    }),
    {
      getState: jest.fn(() => ({
        setViewingConversation: mockSetViewingConversation,
        markConversationRead: mockMarkConversationRead,
        conversations: {},
        userId: null,
        displayName: null,
        contacts: {},
      })),
    },
  ),
}));

import { loadThreadsForGroup } from '../../services/threadService';
const mockLoadThreadsForGroup = loadThreadsForGroup as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();

const emptyThreadsState = {
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
  setReplies: jest.fn(),
  appendReplies: jest.fn(),
  upsertReply: jest.fn(),
  addOptimisticThread: jest.fn(),
  addOptimisticReply: jest.fn(),
  updateThreadSyncStatus: jest.fn(),
  updateReplySyncStatus: jest.fn(),
};

const threadFixture = {
  id: 'thread-1',
  conversationId: 'dm-conv-1',
  authorId: 'user-2',
  authorUsername: 'bob',
  title: 'Hello there',
  body: 'First message in this DM',
  contentType: 'text' as const,
  pinned: false,
  replyCount: 0,
  lastReplyAt: null,
  createdAt: now,
  updatedAt: now,
  syncStatus: 'synced' as const,
};

const populatedThreadsState = {
  ...emptyThreadsState,
  threads: { 'thread-1': threadFixture },
  threadIdsByConversation: { 'dm-conv-1': ['thread-1'] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const mockNavigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
  removeListener: jest.fn(),
  canGoBack: jest.fn(() => true),
  dispatch: jest.fn(),
  isFocused: jest.fn(() => true),
  reset: jest.fn(),
  popToTop: jest.fn(),
  pop: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0, key: 'stack', type: 'stack' })),
  getId: jest.fn(),
  setParams: jest.fn(),
};

function makeRoute(recipientName?: string) {
  return {
    key: 'ChatDetail',
    name: 'ChatDetail' as const,
    params: { conversationId: 'dm-conv-1', recipientName },
  };
}

function renderScreen(recipientName?: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: safeAreaMetrics },
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(ChatDetailScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof ChatDetailScreen>['navigation'],
            route: makeRoute(recipientName) as unknown as React.ComponentProps<typeof ChatDetailScreen>['route'],
          }),
        ),
      ),
    );
  });
  return renderer;
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockUseThreads.mockReturnValue(emptyThreadsState);
  mockBlockedSet = new Set<string>();
  mockSearchState = {
    searchText: '',
    setSearchText: jest.fn(),
    resultThreadIds: [],
    isSearching: false,
    clearSearch: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — rendering', () => {
  it('has testID "chat-detail-screen"', () => {
    const renderer = renderScreen('Bob');
    expect(() => findByTestId(renderer.root, 'chat-detail-screen')).not.toThrow();
  });

  it('renders the recipient name in the header', () => {
    const renderer = renderScreen('Alice');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const nameNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Alice',
    );
    expect(nameNode).toBeDefined();
  });

  it('falls back to "Chat" when no recipientName is provided', () => {
    const renderer = renderScreen(undefined);
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const fallbackNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Chat',
    );
    expect(fallbackNode).toBeDefined();
  });

  it('renders the empty state when there are no threads', () => {
    const renderer = renderScreen('Bob');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No messages yet'),
    );
    expect(emptyNode).toBeDefined();
  });
});

describe('ChatDetailScreen — data loading', () => {
  it('calls loadThreadsForGroup with the conversationId on mount', async () => {
    await act(async () => {
      renderScreen('Bob');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith('dm-conv-1');
  });
});

describe('ChatDetailScreen — with thread data', () => {
  beforeEach(() => {
    mockUseThreads.mockReturnValue(populatedThreadsState);
  });

  it('renders message body when threads are present', () => {
    const renderer = renderScreen('Bob');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const bodyNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'First message in this DM',
    );
    expect(bodyNode).toBeDefined();
  });
});

describe('ChatDetailScreen — navigation', () => {
  beforeEach(() => {
    mockUseThreads.mockReturnValue(populatedThreadsState);
  });

  it('navigates to ThreadDetail when a message item is pressed', () => {
    const renderer = renderScreen('Bob');

    // Find ChatMessageItem by its onPress prop (GestureDetector is mocked,
    // so we invoke the component's onPress callback directly)
    const messageItems = renderer.root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        typeof node.props.threadId === 'string',
    );
    expect(messageItems.length).toBeGreaterThan(0);

    act(() => {
      messageItems[0].props.onPress(messageItems[0].props.threadId);
    });

    expect(mockNavigation.push).toHaveBeenCalledWith('ThreadDetail', {
      threadId: 'thread-1',
      threadTitle: 'Hello there',
    });
  });
});

describe('ChatDetailScreen — focus lifecycle', () => {
  it('calls setViewingConversation and markConversationReadEverywhere on mount', () => {
    mockUseThreads.mockReturnValue(emptyThreadsState);
    const { markConversationReadEverywhere } = jest.requireMock(
      '../../services/conversationService',
    ) as { markConversationReadEverywhere: jest.Mock };
    renderScreen('Alice');

    expect(mockSetViewingConversation).toHaveBeenCalledWith('dm-conv-1');
    expect(markConversationReadEverywhere).toHaveBeenCalledWith('dm-conv-1');
  });

  it('calls setViewingConversation(null) on unmount', () => {
    mockUseThreads.mockReturnValue(emptyThreadsState);
    const renderer = renderScreen('Alice');

    mockSetViewingConversation.mockClear();
    act(() => {
      renderer.unmount();
    });

    expect(mockSetViewingConversation).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// Block filtering — list mode + search mode
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — block filtering', () => {
  const now = Date.now();

  const threadByBlocked: Thread = {
    id: 'thread-blocked',
    conversationId: 'dm-conv-1',
    authorId: 'u-blocked',
    authorUsername: 'blockedUser',
    title: null,
    body: 'Blocked user message',
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  } as Thread;

  const threadByOk: Thread = {
    id: 'thread-ok',
    conversationId: 'dm-conv-1',
    authorId: 'u-ok',
    authorUsername: 'okUser',
    title: null,
    body: 'Allowed user message',
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  } as Thread;

  const blockedThreadsState = {
    ...emptyThreadsState,
    threads: {
      'thread-blocked': threadByBlocked,
      'thread-ok': threadByOk,
    },
    threadIdsByConversation: {
      'dm-conv-1': ['thread-blocked', 'thread-ok'],
    },
  };

  it('hides DM thread rows authored by blocked users', () => {
    mockUseThreads.mockReturnValue(blockedThreadsState);
    mockBlockedSet = new Set(['u-blocked']);

    const renderer = renderScreen('Bob');

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const blockedBody = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Blocked user message',
    );
    const okBody = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Allowed user message',
    );
    expect(blockedBody).toBeUndefined();
    expect(okBody).toBeDefined();
  });

  it('excludes blocked authors\' threads from search results in a DM', () => {
    mockUseThreads.mockReturnValue(blockedThreadsState);
    mockBlockedSet = new Set(['u-blocked']);
    mockSearchState = {
      searchText: 'message',
      setSearchText: jest.fn(),
      resultThreadIds: ['thread-blocked', 'thread-ok'],
      isSearching: true,
      clearSearch: jest.fn(),
    };

    const renderer = renderScreen('Bob');

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const blockedBody = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Blocked user message',
    );
    const okBody = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Allowed user message',
    );
    expect(blockedBody).toBeUndefined();
    expect(okBody).toBeDefined();
  });
});
