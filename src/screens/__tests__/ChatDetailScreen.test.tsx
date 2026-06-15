/**
 * Tests for ChatDetailScreen — thread list in a DM, empty state, data loading, and navigation.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ChatDetailScreen } from '../ChatDetailScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  loadThreadsForGroup: jest.fn().mockResolvedValue([]),
  hydrateThreadsFromLocal: jest.fn(),
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

const mockSetViewingConversation = jest.fn();
const mockMarkConversationRead = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setViewingConversation: mockSetViewingConversation,
      markConversationRead: mockMarkConversationRead,
      conversations: {},
    })),
  },
}));

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

jest.mock('../../hooks/useSQLiteSearch', () => ({
  useSQLiteSearch: () => ({
    searchText: '',
    setSearchText: jest.fn(),
    resultThreadIds: [],
    isSearching: false,
    clearSearch: jest.fn(),
  }),
}));

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
}));

const mockUseThreads = jest.fn();

jest.mock('../../stores', () => ({
  useThreads: (...args: unknown[]) => mockUseThreads(...args),
  useAuth: () => ({ userId: 'test-user-id', username: 'testuser' }),
  useContactForConversation: () => null,
  useAppStore: {
    getState: jest.fn(() => ({
      setViewingConversation: mockSetViewingConversation,
      markConversationRead: mockMarkConversationRead,
      conversations: {},
    })),
  },
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

    // ChatMessageItem renders a TouchableOpacity with accessibilityLabel="Message from {author}"
    const messageItems = renderer.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        /[Mm]essage from bob/.test(node.props.accessibilityLabel),
    );
    expect(messageItems.length).toBeGreaterThan(0);

    act(() => {
      messageItems[0].props.onPress();
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
