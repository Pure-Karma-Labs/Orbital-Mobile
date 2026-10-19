/**
 * Tests for ChatDetailScreen — thread list in a DM, empty state, data loading, and navigation.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ChatDetailScreen } from '../ChatDetailScreen';
import { formatDayLabel } from '../../utils/formatPostTimestamp';
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

// #908: `useBlockedPeerTransition` calls `useIsFocused()`. The real one needs a
// navigation container, so it is driven from this flag — the announcement half
// of the latch is gated on it.
let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => cb(), []);
  },
  useIsFocused: () => mockIsFocused,
}));

const mockSetViewingConversation = jest.fn();
const mockMarkConversationRead = jest.fn();

// Mutable so a test can render the muted bell (#449).
let mockMutedTargets: Record<string, string> = {};

jest.mock('../../services/notificationSettingsSync', () => ({
  toggleMute: jest.fn().mockResolvedValue(true),
}));

// #908: the slices the real useBlockedDmPeer derives from. Mutable and rebuilt
// per read, so a test can block a peer and re-render.
let mockStoreConversations: Record<string, unknown> = {};
let mockStoreContacts: Record<string, unknown> = {};
let mockBlockedUserIds: string[] = [];

jest.mock('../../stores/useAppStore', () => {
  const getState = () => ({
    setViewingConversation: mockSetViewingConversation,
    markConversationRead: mockMarkConversationRead,
    conversations: mockStoreConversations,
    userId: null,
    displayName: null,
    contacts: mockStoreContacts,
    blockedUserIds: mockBlockedUserIds,
    blockedUserProfiles: {},
  });
  return {
    useAppStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState: jest.fn(getState) },
    ),
  };
});

// #908: BlockedPeerNotice -> confirmUnblock -> blockedContentRefresh reaches
// the store singleton (MMKV), which does not load under jest.
jest.mock('../../services/blockedContentRefresh', () => ({
  unblockUserAndRefresh: jest.fn(),
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

/**
 * #912: the per-group heal counter. The real `useGroupKeyGeneration` reads the
 * store singleton (MMKV), which does not load under jest; a test bumps this and
 * re-renders to stand in for `wrapped_key_delivered` landing.
 */
let mockKeyGeneration = 0;

jest.mock('../../stores', () => {
  const getState = () => ({
    setViewingConversation: mockSetViewingConversation,
    markConversationRead: mockMarkConversationRead,
    conversations: {},
    userId: null,
    displayName: null,
    contacts: {},
    mutedTargets: mockMutedTargets,
  });
  return {
    useThreads: (...args: unknown[]) => mockUseThreads(...args),
    useAuth: () => ({ userId: 'test-user-id', username: 'testuser' }),
    useContactForConversation: () => null,
    useGroupKeyGeneration: () => mockKeyGeneration,
    useAppStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState: jest.fn(getState) },
    ),
  };
});

import { loadThreadsForGroup } from '../../services/threadService';
const mockLoadThreadsForGroup = loadThreadsForGroup as jest.Mock;

import { toggleMute } from '../../services/notificationSettingsSync';
const mockToggleMute = toggleMute as jest.Mock;

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

/**
 * `conversationId` is a parameter so a test can re-render this screen pointed
 * at ANOTHER DM — a params-in-place navigate, which keeps the same mount.
 */
function makeRoute(
  recipientName?: string,
  recipientId?: string,
  conversationId = 'dm-conv-1',
) {
  return {
    key: 'ChatDetail',
    name: 'ChatDetail' as const,
    params: { conversationId, recipientName, recipientId },
  };
}

function screenElement(
  recipientName?: string,
  recipientId?: string,
  conversationId?: string,
): React.ReactElement {
  return React.createElement(
    SafeAreaProvider,
    { initialMetrics: safeAreaMetrics },
    React.createElement(
      ThemeProvider,
      { colorSchemeOverride: 'light' },
      React.createElement(ChatDetailScreen, {
        navigation: mockNavigation as unknown as React.ComponentProps<typeof ChatDetailScreen>['navigation'],
        route: makeRoute(recipientName, recipientId, conversationId) as unknown as React.ComponentProps<typeof ChatDetailScreen>['route'],
      }),
    ),
  );
}

function renderScreen(
  recipientName?: string,
  recipientId?: string,
  conversationId?: string,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(screenElement(recipientName, recipientId, conversationId));
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
  mockIsFocused = true;
  mockKeyGeneration = 0;
  mockUseThreads.mockReturnValue(emptyThreadsState);
  mockBlockedSet = new Set<string>();
  mockStoreConversations = {};
  mockStoreContacts = {};
  mockBlockedUserIds = [];
  mockMutedTargets = {};
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

  // An unrenderable createdAt gets no day row of its own and must not close the
  // group it lands in: otherwise the real day re-opens, duplicating its
  // `day-<key>` FlatList key and adding a stray section row (#845).
  it('skips the day row for an unrenderable timestamp without splitting the day group', () => {
    mockUseThreads.mockReturnValue({
      ...emptyThreadsState,
      threads: {
        'thread-1': threadFixture,
        'thread-nan': { ...threadFixture, id: 'thread-nan', body: 'Corrupt date', createdAt: NaN },
      },
      threadIdsByConversation: { 'dm-conv-1': ['thread-1', 'thread-nan'] },
    });

    const renderer = renderScreen('Bob');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const sectionGlyph = '·  ·  ·  ✦  ·  ·  ·';
    const dayRows = allText.filter((node) => node.props.children === '─── Today ───');
    const sectionRows = allText.filter((node) => node.props.children === sectionGlyph);

    expect(dayRows).toHaveLength(1);
    expect(sectionRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Activity ordering and day grouping (#883)
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — activity ordering', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function textIndex(renderer: ReactTestRenderer, value: string): number {
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    return allText.findIndex((node) => node.props.children === value);
  }

  // A reply has to bring its message back to the top of the DM, which is the
  // whole point of #883 — creation order would put the quiet message first.
  it('sorts an old message with a recent reply above a newer message with none', () => {
    mockUseThreads.mockReturnValue({
      ...emptyThreadsState,
      threads: {
        'thread-old': {
          ...threadFixture,
          id: 'thread-old',
          body: 'Old message with a new reply',
          createdAt: now - 5 * DAY,
          lastReplyAt: now,
          replyCount: 1,
        },
        'thread-new': {
          ...threadFixture,
          id: 'thread-new',
          body: 'Newer quiet message',
          createdAt: now - 60_000,
          lastReplyAt: null,
        },
      },
      // Store order deliberately favours the wrong answer.
      threadIdsByConversation: { 'dm-conv-1': ['thread-new', 'thread-old'] },
    });

    const renderer = renderScreen('Bob');
    const oldIndex = textIndex(renderer, 'Old message with a new reply');
    const newIndex = textIndex(renderer, 'Newer quiet message');

    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeLessThan(newIndex);
  });

  // The day header is grouped on ACTIVITY, so a message created days ago whose
  // last reply landed today sits under "Today" — one header, and no section
  // separator, because there is only one group.
  it('renders one activity-day header and no section row when activity and creation differ', () => {
    const createdAt = now - 3 * DAY;
    mockUseThreads.mockReturnValue({
      ...emptyThreadsState,
      threads: {
        'thread-bumped': {
          ...threadFixture,
          id: 'thread-bumped',
          body: 'Bumped message',
          createdAt,
          lastReplyAt: now,
          replyCount: 1,
        },
      },
      threadIdsByConversation: { 'dm-conv-1': ['thread-bumped'] },
    });

    const renderer = renderScreen('Bob');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const dayRows = allText.filter(
      (node) =>
        typeof node.props.children === 'string' && node.props.children.startsWith('─── '),
    );
    const sectionRows = allText.filter(
      (node) => node.props.children === '·  ·  ·  ✦  ·  ·  ·',
    );

    expect(dayRows).toHaveLength(1);
    expect(dayRows[0].props.children).toBe('─── Today ───');
    // Not grouped on creation day.
    expect(dayRows[0].props.children).not.toBe(`─── ${formatDayLabel(createdAt)} ───`);
    expect(sectionRows).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Header actions: mute bell beside the compose "+" (#449)
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — header mute bell', () => {
  it('renders BOTH the mute bell and the compose "+" in the header', () => {
    const renderer = renderScreen('Bob');

    expect(() => findByTestId(renderer.root, 'chat-mute-bell')).not.toThrow();
    const compose = findByTestId(renderer.root, 'chat-compose-button');
    expect(compose.props.accessibilityLabel).toBe('New thread');
  });

  it('the compose "+" still navigates to the composer', () => {
    const renderer = renderScreen('Bob');

    act(() => {
      findByTestId(renderer.root, 'chat-compose-button').props.onPress();
    });

    expect(mockNavigation.navigate).toHaveBeenCalledWith('ComposeChatThread', {
      groupId: 'dm-conv-1',
      isDm: true,
    });
  });

  it('the bell reflects the unmuted state', () => {
    const renderer = renderScreen('Bob');
    const bell = findByTestId(renderer.root, 'chat-mute-bell');

    expect(bell.props.accessibilityLabel).toBe('Mute this chat');
    expect(bell.props.accessibilityState).toEqual({ selected: false });
  });

  it('the bell reflects the muted state and swaps the glyph', () => {
    mockMutedTargets = { 'dm-conv-1': 'group' };
    const renderer = renderScreen('Bob');
    const bell = findByTestId(renderer.root, 'chat-mute-bell');

    expect(bell.props.accessibilityLabel).toBe('Unmute this chat');
    expect(bell.props.accessibilityState).toEqual({ selected: true });
    expect(
      renderer.root.findAll((n) => n.props.unified === '1F515').length,
    ).toBeGreaterThan(0);
  });

  it('tapping the bell mutes the conversation as a group target', () => {
    const renderer = renderScreen('Bob');

    act(() => {
      findByTestId(renderer.root, 'chat-mute-bell').props.onPress();
    });

    expect(mockToggleMute).toHaveBeenCalledWith('dm-conv-1', 'group');
  });
});

// ---------------------------------------------------------------------------
// Blocked DM peer (#908)
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — blocked DM peer', () => {
  const PEER_ID = 'u-bob';

  /** The DM row as written since #908: the peer id is on the row. */
  function seedDmRow(): void {
    mockStoreConversations = {
      'dm-conv-1': {
        id: 'dm-conv-1',
        type: 'direct',
        name: 'bob',
        peerUserId: PEER_ID,
        memberCount: 2,
        active: true,
        lastMessageAt: null,
        unreadCount: 0,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  function texts(renderer: ReactTestRenderer): unknown[] {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children);
  }

  function has(renderer: ReactTestRenderer, testID: string): boolean {
    return renderer.root.findAll((node) => node.props.testID === testID).length > 0;
  }

  it('replaces the empty state with the notice and drops the CTA and the "+"', () => {
    seedDmRow();
    mockBlockedUserIds = [PEER_ID];

    const renderer = renderScreen('Bob');

    expect(has(renderer, 'blocked-peer-notice')).toBe(true);
    expect(texts(renderer)).not.toContain('No messages yet\nStart the conversation!');
    expect(texts(renderer)).not.toContain('Send a Message');
    expect(has(renderer, 'chat-compose-button')).toBe(false);
    // The mute bell stays.
    expect(has(renderer, 'chat-mute-bell')).toBe(true);
  });

  it('renders the notice above the list when the user has older threads of their own', () => {
    seedDmRow();
    mockUseThreads.mockReturnValue(populatedThreadsState);
    mockBlockedUserIds = [PEER_ID];

    const renderer = renderScreen('Bob');

    expect(has(renderer, 'blocked-peer-notice')).toBe(true);
    // The existing thread is still readable (it is the viewer's own history).
    expect(texts(renderer)).toContain('First message in this DM');
    expect(has(renderer, 'chat-compose-button')).toBe(false);
  });

  it('keeps the normal empty state and the "+" when the peer is not blocked', () => {
    seedDmRow();

    const renderer = renderScreen('Bob');

    expect(has(renderer, 'blocked-peer-notice')).toBe(false);
    expect(texts(renderer)).toContain('No messages yet\nStart the conversation!');
    expect(has(renderer, 'chat-compose-button')).toBe(true);
  });

  it('uses the route recipientId hint when the conversation row is missing', () => {
    // A push tap or deep link can land here before the DM list has loaded.
    mockBlockedUserIds = [PEER_ID];

    const renderer = renderScreen('Bob', PEER_ID);

    expect(has(renderer, 'blocked-peer-notice')).toBe(true);
    expect(has(renderer, 'chat-compose-button')).toBe(false);
  });

  it('restores the composer entry points on an unblock', () => {
    seedDmRow();
    mockBlockedUserIds = [PEER_ID];
    const renderer = renderScreen('Bob');
    expect(has(renderer, 'chat-compose-button')).toBe(false);

    mockBlockedUserIds = [];
    act(() => {
      renderer.update(screenElement('Bob'));
    });

    expect(has(renderer, 'blocked-peer-notice')).toBe(false);
    expect(has(renderer, 'chat-compose-button')).toBe(true);
  });

  // `handleCompose`'s own `if (isBlocked) return` cannot be reached from the
  // committed tree: `isBlocked` gates BOTH the render of every control that
  // carries the callback AND the callback body, so any render that hands out
  // `handleCompose` has `isBlocked === false` in its closure. What IS testable
  // — and what the guard exists to protect — is the observable contract: while
  // blocked, pressing EVERYTHING the screen still renders opens no composer.
  it('opens no composer from any control still on screen while blocked', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    seedDmRow();
    mockUseThreads.mockReturnValue(populatedThreadsState);
    mockBlockedUserIds = [PEER_ID];

    const renderer = renderScreen('Bob');

    // Composite nodes: `onPress` never reaches a host element (Touchable
    // translates it into responder props), so the host filter used elsewhere
    // in this suite would match nothing here.
    const pressables = renderer.root.findAll((node) => typeof node.props.onPress === 'function');
    // Positive control: the sweep has to actually find the controls that are
    // still rendered (the mute bell, the notice's Unblock, the rows).
    expect(pressables.length).toBeGreaterThan(0);

    act(() => {
      for (const node of pressables) node.props.onPress();
    });

    const composerCalls = [
      ...mockNavigation.navigate.mock.calls,
      ...mockNavigation.push.mock.calls,
    ].filter(([routeName]) => routeName === 'ComposeChatThread');
    expect(composerCalls).toEqual([]);
    alertSpy.mockRestore();
  });

  it('resolves the peer from contacts when the row predates #908', () => {
    mockStoreConversations = {
      'dm-conv-1': {
        id: 'dm-conv-1',
        type: 'direct',
        name: 'bob',
        memberCount: 2,
        active: true,
        lastMessageAt: null,
        unreadCount: 0,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    mockStoreContacts = {
      [PEER_ID]: { id: PEER_ID, username: 'bob', conversationIds: ['dm-conv-1'] },
    };
    mockBlockedUserIds = [PEER_ID];

    const renderer = renderScreen('Bob');

    expect(has(renderer, 'blocked-peer-notice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group-key failures on the read surface (#912)
//
// This is the reported #912 screen: a DM whose key had been wrapped to the
// member's pre-reset identity key rendered "No messages yet / Start the
// conversation!" over a conversation full of history.
// ---------------------------------------------------------------------------

describe('ChatDetailScreen — group key (#912)', () => {
  // Pinned as literals, never imported from utils/errorMessages.
  const UNREADABLE =
    "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";
  const PENDING_NOTICE = 'Re-sending encryption key…';

  function pendingWrap(): Error {
    const e = new Error('Group key not yet available (pending wrap)');
    e.name = 'PendingWrapError';
    return e;
  }

  function unwrapFailure(selfHeal: string): Error {
    const e = new Error(`Group key unwrap failed: recipient_mismatch / ${selfHeal}`);
    e.name = 'GroupKeyUnwrapError';
    (e as unknown as { selfHeal: string }).selfHeal = selfHeal;
    return e;
  }

  /** Render and flush the load effect's promise. */
  async function render(): Promise<ReactTestRenderer> {
    const renderer = renderScreen('Bob');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    return renderer;
  }

  async function rerender(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => {
      renderer.update(screenElement('Bob'));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  function count(renderer: ReactTestRenderer, testID: string): number {
    return renderer.root.findAll((node) => node.props.testID === testID).length;
  }

  function texts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children)
      .filter((c): c is string => typeof c === 'string');
  }

  afterEach(() => {
    mockLoadThreadsForGroup.mockResolvedValue([]);
  });

  it('replaces the create-first empty state with the pending notice', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());

    const renderer = await render();

    expect(count(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);
    const rendered = texts(renderer);
    expect(rendered).toContain(PENDING_NOTICE);
    expect(rendered.join('\n')).not.toContain('No messages yet');
    expect(rendered).not.toContain('Send a Message');
    expect(count(renderer, 'group-key-pending-body')).toBeGreaterThan(0);
  });

  it('shows the outcome copy in place of the empty state', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('exhausted'));

    const renderer = await render();

    expect(count(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);
    const rendered = texts(renderer);
    expect(rendered).toContain(UNREADABLE);
    expect(rendered.join('\n')).not.toContain('No messages yet');
    expect(count(renderer, 'group-key-pending-banner')).toBe(0);
  });

  it('keeps the normal empty state for a failure that is not a key failure', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));

    const renderer = await render();

    expect(texts(renderer).join('\n')).toContain('No messages yet');
    expect(count(renderer, 'group-key-pending-banner')).toBe(0);
    expect(count(renderer, 'group-key-failure-notice')).toBe(0);
  });

  it('lets the blocked-peer notice win over a key notice', async () => {
    // A block is the user's own decision; a key problem is not actionable.
    mockStoreConversations = {
      'dm-conv-1': { id: 'dm-conv-1', type: 'direct', peerUserId: 'u-bob', name: 'bob' },
    };
    mockBlockedUserIds = ['u-bob'];
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());

    const renderer = await render();

    expect(count(renderer, 'blocked-peer-notice')).toBeGreaterThan(0);
    expect(count(renderer, 'group-key-pending-body')).toBe(0);
  });

  it('reloads and clears the notice when the generation is bumped (D11)', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());

    const renderer = await render();
    expect(count(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);

    // The heal lands: handleWrappedKeyDelivered fetched the delivered key and
    // bumped the counter. The OPEN screen reloads itself (B2).
    mockKeyGeneration = 1;
    await rerender(renderer);

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(count(renderer, 'group-key-pending-banner')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No messages yet');
  });

  it('does not reload while the generation is unchanged', async () => {
    const renderer = await render();
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);

    await rerender(renderer);

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);
  });

  // The milder form of the ThreadsScreen leak: a params-in-place navigate to
  // another DM keeps this mount, so the previous conversation's key state has
  // to go with it. The second load fails for a NON-key reason, which leaves
  // the flags alone — so only the conversation change itself can clear them.
  it('drops the notice when the route points at another conversation', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('refused'));

    const renderer = await render();
    expect(count(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);

    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      renderer.update(screenElement('Bob', undefined, 'dm-conv-2'));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(count(renderer, 'group-key-failure-notice')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No messages yet');
    expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('dm-conv-2');
  });

  // `loadThreadsForGroup` is not cancellable, so the first DM's rejection can
  // land after the screen has re-pointed. Its verdict must be dropped.
  it('ignores a rejection that lands after the route re-pointed', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());
    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));

    // Rendered but NOT flushed: the first DM's load is still in flight.
    const renderer = renderScreen('Bob');
    await act(async () => {
      renderer.update(screenElement('Bob', undefined, 'dm-conv-2'));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(count(renderer, 'group-key-pending-banner')).toBe(0);
    expect(count(renderer, 'group-key-pending-body')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No messages yet');
  });
});
