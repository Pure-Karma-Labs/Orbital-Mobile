/**
 * Tests for ThreadsScreen — inbox screen with orbit bar, search, and thread list.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadsScreen } from '../ThreadsScreen';
import { getThreadState } from '../../utils/threadState';
import { formatDayLabel } from '../../utils/formatPostTimestamp';
import { makeThread as makeThreadFixture } from '../../testUtils/makeThread';
import type { Thread } from '../../types/store';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  loadThreadsForGroup: jest.fn().mockResolvedValue([]),
  hydrateThreadsFromLocal: jest.fn(),
  // #923 paging seams. The hook under the screen is REAL here: these three are
  // the only things it touches outside the store.
  loadMoreThreadsForGroup: jest
    .fn()
    .mockResolvedValue({ status: 'loaded', newIdCount: 0, hasMore: true }),
  leaveThreadList: jest.fn(),
  ensureThreadEntitiesCached: jest.fn().mockReturnValue(0),
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

jest.mock('../../hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    scrollY: { interpolate: () => 0 },
    scrollProps: {},
  }),
}));

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
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

const mockSetViewingConversation = jest.fn();
const mockMarkConversationRead = jest.fn();

// Mutable so a test can render a muted row (#449).
let mockMutedTargets: Record<string, string> = {};

jest.mock('../../services/notificationSettingsSync', () => ({
  toggleMute: jest.fn().mockResolvedValue(true),
}));

/**
 * #912: the per-group heal counter. The real `useGroupKeyGeneration` reads the
 * store singleton (MMKV), which does not load under jest; a test bumps this and
 * re-renders to stand in for `wrapped_key_delivered` landing.
 */
let mockKeyGeneration = 0;

/**
 * The active orbit, mutable so a test can SWITCH orbits: the screen stays
 * mounted across a switch, and both the selector and `getState()` have to agree
 * on which orbit is active — the load's `.then`/`.catch` read the imperative
 * one to decide whether their verdict is still current.
 */
let mockActiveConversationId: string | null = 'group-1';

/**
 * The paging slot `threadListWalk` writes (#923). The screen's hook reads it
 * through `useThreadListPagingState`; a test sets it to stand in for a walk
 * that has (or has not) more pages.
 */
let mockThreadListPaging = {
  hasMore: false,
  loadingMore: false,
  loadMoreFailed: false,
  totalCount: 0,
};

jest.mock('../../stores', () => {
  const getState = () => ({
    setViewingConversation: mockSetViewingConversation,
    markConversationRead: mockMarkConversationRead,
    conversations: {},
    activeConversationId: mockActiveConversationId,
    userId: null,
    displayName: null,
    contacts: {},
    mutedTargets: mockMutedTargets,
  });
  const useAppStore = Object.assign(
    (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState: jest.fn(getState) },
  );
  return {
  useAppStore,
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
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
      'group-2': {
        id: 'group-2',
        type: 'group',
        name: 'Second Orbit',
        memberCount: 2,
        active: true,
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    },
    conversationIds: ['group-1', 'group-2'],
    activeConversationId: mockActiveConversationId,
    setConversations: jest.fn(),
    setGroupConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
  }),
  useGroupKeyGeneration: () => mockKeyGeneration,
  useThreadListPagingState: () => mockThreadListPaging,
  useConnection: () => ({
    connectionStatus: 'connected',
    lastConnectedAt: null,
    reconnectAttempt: 0,
    setConnectionStatus: jest.fn(),
    setLastConnectedAt: jest.fn(),
    setReconnectAttempt: jest.fn(),
    clearTypingUsers: jest.fn(),
  }),
};});

import { toggleMute } from '../../services/notificationSettingsSync';
const mockToggleMute = toggleMute as jest.Mock;

import {
  loadThreadsForGroup,
  loadMoreThreadsForGroup,
  leaveThreadList,
  ensureThreadEntitiesCached,
} from '../../services/threadService';
// #912: the load seam the group-key read-surface cases drive.
const mockLoadThreadsForGroup = loadThreadsForGroup as jest.Mock;
// #923: the walk seams.
const mockLoadMoreThreadsForGroup = loadMoreThreadsForGroup as jest.Mock;
const mockLeaveThreadList = leaveThreadList as jest.Mock;
const mockEnsureThreadEntitiesCached = ensureThreadEntitiesCached as jest.Mock;

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
// Top-level reset for mutable mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedSet = new Set<string>();
  mockMutedTargets = {};
  mockKeyGeneration = 0;
  mockActiveConversationId = 'group-1';
  mockThreadListPaging = {
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    totalCount: 0,
  };
  mockLoadMoreThreadsForGroup.mockResolvedValue({
    status: 'loaded',
    newIdCount: 0,
    hasMore: true,
  });
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

  // #826: `isDm` is a REQUIRED ComposeThreadParams field, and this is the only
  // producer that used to omit it. An omitted `isDm` makes the composer's
  // upload telemetry drop the `dm` tag entirely rather than report 'false', so
  // the param must be passed explicitly — asserted with an exact-object match,
  // not objectContaining, so a dropped field fails here.
  it('composing navigates to ComposeThread with the active orbit and isDm: false', () => {
    const renderer = renderThreadsScreen();
    const composeNodes = renderer.root.findAll(
      (node) => typeof node.props.onCompose === 'function',
    );
    expect(composeNodes.length).toBeGreaterThan(0);

    act(() => {
      composeNodes[0].props.onCompose();
    });

    expect(mockNavigation.navigate).toHaveBeenCalledWith('ComposeThread', {
      groupId: 'group-1',
      isDm: false,
    });
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
        // The shared builder, not a literal: `Thread` gained three required
        // fields in #927, and a literal here would have gone on describing a
        // row no mapper can produce (this mock is untyped).
        'thread-1': makeThreadFixture({
          id: 'thread-1',
          conversationId: 'group-1',
          authorId: 'user-1',
          authorUsername: 'alice',
          title: "Farmer's market on Saturday?",
          body: null,
          contentType: 'text',
          replyCount: 3,
          lastReplyAt: now,
          createdAt: now,
          updatedAt: now,
        }),
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

  // An unrenderable activity time gets no day row of its own and must not close
  // the group it lands in: otherwise the real day re-opens, duplicating its
  // `day-<key>` FlatList key and adding a stray section row (#845).
  it('skips the day row for an unrenderable timestamp without splitting the day group', () => {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    const base = storesMock.useThreads() as {
      threads: Record<string, Thread>;
    } & Record<string, unknown>;
    const validId = 'thread-1';

    storesMock.useThreads.mockReturnValue({
      ...base,
      threads: {
        ...base.threads,
        'thread-nan': {
          ...base.threads[validId],
          id: 'thread-nan',
          title: 'Corrupt date',
          createdAt: NaN,
          lastReplyAt: NaN,
        },
      },
      threadIdsByConversation: { 'group-1': [validId, 'thread-nan'] },
    });

    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const sectionGlyph = '·  ·  ·  ✦  ·  ·  ·';
    const dayRows = allText.filter((node) => node.props.children === '─── Today ───');
    const sectionRows = allText.filter((node) => node.props.children === sectionGlyph);

    expect(dayRows).toHaveLength(1);
    expect(sectionRows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Per-thread muting (#449)
  // -------------------------------------------------------------------------

  /** The thread row's pressable — identified by its mute a11y hint. */
  function threadRow(renderer: ReactTestRenderer) {
    const rows = renderer.root.findAll(
      (n) => n.props.accessibilityHint === 'Long press for notification options',
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  it('long-pressing a thread row opens the mute Alert with the thread title', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderThreadsScreen();

    act(() => {
      threadRow(renderer).props.onLongPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      "Farmer's market on Saturday?",
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Mute notifications' }),
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      ]),
    );
    alertSpy.mockRestore();
  });

  it('choosing "Mute notifications" calls toggleMute with the thread target', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderThreadsScreen();

    act(() => {
      threadRow(renderer).props.onLongPress();
    });
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    act(() => {
      buttons.find((b) => b.text === 'Mute notifications')!.onPress!();
    });

    expect(mockToggleMute).toHaveBeenCalledWith('thread-1', 'thread');
    alertSpy.mockRestore();
  });

  it('offers Unmute (not Mute) when the thread is already muted', () => {
    mockMutedTargets = { 'thread-1': 'thread' };
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderThreadsScreen();

    act(() => {
      threadRow(renderer).props.onLongPress();
    });

    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string }>;
    expect(buttons.map((b) => b.text)).toContain('Unmute notifications');
    expect(buttons.map((b) => b.text)).not.toContain('Mute notifications');
    alertSpy.mockRestore();
  });

  it('renders the muted indicator only when the thread is in mutedTargets', () => {
    const unmuted = renderThreadsScreen();
    expect(
      unmuted.root.findAll((n) => n.props.testID === 'thread-muted-indicator'),
    ).toHaveLength(0);

    mockMutedTargets = { 'thread-1': 'thread' };
    const muted = renderThreadsScreen();
    expect(
      muted.root.findAll((n) => n.props.testID === 'thread-muted-indicator').length,
    ).toBeGreaterThan(0);
  });

  it('exposes a mute accessibilityAction that fires the same menu', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderThreadsScreen();
    const row = threadRow(renderer);

    expect(row.props.accessibilityActions).toEqual([
      { name: 'mute', label: 'Mute notifications' },
    ]);

    act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'mute' } });
    });

    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('labels the accessibilityAction "Unmute notifications" when muted', () => {
    mockMutedTargets = { 'thread-1': 'thread' };
    const renderer = renderThreadsScreen();

    expect(threadRow(renderer).props.accessibilityActions).toEqual([
      { name: 'mute', label: 'Unmute notifications' },
    ]);
  });

  it('ignores unrelated accessibility actions', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderThreadsScreen();

    act(() => {
      threadRow(renderer).props.onAccessibilityAction({
        nativeEvent: { actionName: 'magicTap' },
      });
    });

    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Empty titles (#926)
  // -------------------------------------------------------------------------
  //
  // An imported (Meta) post can legitimately carry an empty title, and `??`
  // passes `''` straight through: the row title collapses to zero height and
  // the screen reader announces a bare 'Thread: '. Both call sites use `||`.

  /** Re-point the threads mock at a single empty-titled thread. */
  function renderWithEmptyTitle(): ReactTestRenderer {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    const base = storesMock.useThreads() as {
      threads: Record<string, Thread>;
    } & Record<string, unknown>;
    storesMock.useThreads.mockReturnValue({
      ...base,
      threads: { 'thread-1': { ...base.threads['thread-1'], title: '' } },
    });
    return renderThreadsScreen();
  }

  it('renders the (no title) fallback and a non-empty a11y label for an empty title', () => {
    const renderer = renderWithEmptyTitle();

    expect(threadRow(renderer).props.accessibilityLabel).toBe('Thread: (no title)');

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const titleNode = allText.find((node) => node.props.children === '(no title)');
    expect(titleNode).toBeDefined();
  });

  it('opens the mute menu as "Thread" when the title is empty', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderWithEmptyTitle();

    act(() => {
      threadRow(renderer).props.onLongPress();
    });

    expect(alertSpy).toHaveBeenCalledWith('Thread', expect.any(String), expect.any(Array));
    alertSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Derived headlines and imported rows (#927)
  // -------------------------------------------------------------------------

  /** Re-point the threads mock at one thread built from the base fixture. */
  function renderWithThread(overrides: Partial<Thread>): ReactTestRenderer {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    const base = storesMock.useThreads() as {
      threads: Record<string, Thread>;
    } & Record<string, unknown>;
    storesMock.useThreads.mockReturnValue({
      ...base,
      threads: { 'thread-1': { ...base.threads['thread-1'], ...overrides } },
    });
    return renderThreadsScreen();
  }

  /** Every string a node renders, in order, flattened across nesting. */
  function flattenText(children: unknown): string {
    if (typeof children === 'string') return children;
    if (Array.isArray(children)) return children.map(flattenText).join('');
    return '';
  }

  /** The row's one-line meta `Text` — the line that truncates. */
  function metaLine(renderer: ReactTestRenderer) {
    const nodes = renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .filter((node) => node.props.numberOfLines === 1 && Array.isArray(node.props.children));
    expect(nodes.length).toBeGreaterThan(0);
    return nodes[0];
  }

  /**
   * HOST nodes only: `findAll` by testID also matches the component node that
   * passes the prop down, so a mounted indicator would otherwise count twice.
   */
  function indicators(renderer: ReactTestRenderer) {
    return renderer.root.findAll(
      (n) => typeof n.type === 'string' && n.props.testID === 'thread-imported-indicator',
    );
  }

  /** 2014-06-01T12:00:00.000Z — the server's synthetic key for an import. */
  const IMPORTED_AT = Date.UTC(2014, 5, 1, 12, 0, 0, 0);

  it('derives the row title from the body when there is no title', () => {
    const renderer = renderWithThread({ title: '', body: 'Back from the lake.' });

    expect(threadRow(renderer).props.accessibilityLabel).toBe('Thread: Back from the lake.');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    expect(allText.some((n) => n.props.children === 'Back from the lake.')).toBe(true);
  });

  it('derives a photo count and a link host', () => {
    const photos = renderWithThread({
      title: '',
      body: null,
      contentType: 'media',
      mediaCount: 3,
    });
    expect(threadRow(photos).props.accessibilityLabel).toBe('Thread: 3 photos');

    const link = renderWithThread({ title: '', body: 'https://www.example.com/article' });
    expect(threadRow(link).props.accessibilityLabel).toBe('Thread: example.com');
  });

  it('names the thread in the mute menu with the derived headline', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderWithThread({ title: '', body: 'Back from the lake.' });

    act(() => {
      threadRow(renderer).props.onLongPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Back from the lake.',
      expect.any(String),
      expect.any(Array),
    );
    alertSpy.mockRestore();
  });

  it('badges an imported row and says the source and date out loud', () => {
    const renderer = renderWithThread({
      title: '',
      body: 'Back from the lake.',
      isImport: true,
      importSource: 'facebook',
      createdAt: IMPORTED_AT,
      lastReplyAt: null,
    });

    expect(indicators(renderer)).toHaveLength(1);
    expect(threadRow(renderer).props.accessibilityLabel).toBe(
      'Thread: Back from the lake., imported from Facebook, June 1, 2014',
    );
  });

  it('shows the original date, with its year and no clock time', () => {
    const renderer = renderWithThread({
      isImport: true,
      importSource: 'facebook',
      createdAt: IMPORTED_AT,
      lastReplyAt: null,
    });

    const meta = flattenText(metaLine(renderer).props.children);
    expect(meta).toContain('Jun 1, 2014');
    expect(meta).not.toMatch(/\d{1,2}:\d{2} (AM|PM)/);
  });

  it('leaves a native row with its clock time and no badge', () => {
    const renderer = renderThreadsScreen();

    expect(indicators(renderer)).toHaveLength(0);
    const meta = flattenText(metaLine(renderer).props.children);
    expect(meta).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(threadRow(renderer).props.accessibilityLabel).toBe(
      "Thread: Farmer's market on Saturday?",
    );
  });

  it('says "imported post" when the source could not be read', () => {
    const renderer = renderWithThread({
      isImport: true,
      importSource: null,
      createdAt: IMPORTED_AT,
      lastReplyAt: null,
    });

    expect(indicators(renderer)).toHaveLength(1);
    expect(threadRow(renderer).props.accessibilityLabel).toBe(
      "Thread: Farmer's market on Saturday?, imported post, June 1, 2014",
    );
  });

  // The reason the glyph is a sibling of the meta line rather than its last
  // child: a 64-character display name truncates that line, and anything
  // inside it goes with the text.
  it('keeps the badge outside the truncating meta line, under a 64-char name', () => {
    const renderer = renderWithThread({
      authorUsername: 'a'.repeat(64),
      isImport: true,
      importSource: 'instagram',
      createdAt: IMPORTED_AT,
      lastReplyAt: null,
    });

    expect(indicators(renderer)).toHaveLength(1);
    // Structural, not visual: the indicator is not a descendant of the Text
    // that truncates, so no name length can take it off screen.
    const meta = metaLine(renderer);
    expect(meta.findAll((n) => n.props.testID === 'thread-imported-indicator')).toHaveLength(0);
    expect(flattenText(meta.props.children)).toContain('a'.repeat(64));
    expect(threadRow(renderer).props.accessibilityLabel).toContain('imported from Instagram');
  });

  it('carries the STORED title into navigation, never the derived headline', () => {
    const renderer = renderWithThread({
      title: '',
      body: 'Back from the lake.',
      isImport: true,
      importSource: 'facebook',
      createdAt: IMPORTED_AT,
    });

    act(() => {
      threadRow(renderer).props.onPress();
    });

    expect(mockNavigation.push).toHaveBeenCalledWith('ThreadDetail', {
      threadId: 'thread-1',
      threadTitle: undefined,
    });
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
// Activity ordering and day grouping (#883)
// ---------------------------------------------------------------------------

describe('ThreadsScreen — activity ordering', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const nowTs = Date.now();

  const baseThread = makeThreadFixture({
    id: 'thread-base',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'Base thread',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: nowTs,
    updatedAt: nowTs,
    syncStatus: 'synced',
  });

  function setThreads(threads: Record<string, Thread>, ids: string[]): void {
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue({
      threads,
      threadIdsByConversation: { 'group-1': ids },
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
  }

  function textIndex(renderer: ReactTestRenderer, value: string): number {
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    return allText.findIndex((node) => node.props.children === value);
  }

  // A reply has to lift its thread back to the top — creation order would put
  // the quiet thread first (#883).
  it('sorts an old thread with a recent reply above a newer thread with none', () => {
    setThreads(
      {
        'thread-old': {
          ...baseThread,
          id: 'thread-old',
          title: 'Old thread with a new reply',
          createdAt: nowTs - 5 * DAY,
          lastReplyAt: nowTs,
          replyCount: 1,
        },
        'thread-new': {
          ...baseThread,
          id: 'thread-new',
          title: 'Newer quiet thread',
          createdAt: nowTs - 60_000,
          lastReplyAt: null,
        },
      },
      // Store order deliberately favours the wrong answer.
      ['thread-new', 'thread-old'],
    );

    const renderer = renderThreadsScreen();
    const oldIndex = textIndex(renderer, 'Old thread with a new reply');
    const newIndex = textIndex(renderer, 'Newer quiet thread');

    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeLessThan(newIndex);
  });

  // A corrupt lastReplyAt must not erase the thread's position or its day
  // header: the previous `lastReplyAt ?? createdAt` read NaN as the activity,
  // which made the sort comparator return NaN (spec-coerced to 0, so the rows
  // kept store order) and the day key '' (no header at all).
  it('falls back to createdAt when lastReplyAt is corrupt', () => {
    const olderCreatedAt = nowTs - 2 * DAY;
    setThreads(
      {
        'thread-corrupt': {
          ...baseThread,
          id: 'thread-corrupt',
          title: 'Corrupt reply stamp',
          createdAt: nowTs,
          lastReplyAt: NaN,
          replyCount: 1,
        },
        'thread-older': {
          ...baseThread,
          id: 'thread-older',
          title: 'Older plain thread',
          createdAt: olderCreatedAt,
          lastReplyAt: null,
        },
      },
      // Store order deliberately favours the wrong answer.
      ['thread-older', 'thread-corrupt'],
    );

    const renderer = renderThreadsScreen();
    const corruptIndex = textIndex(renderer, 'Corrupt reply stamp');
    const olderIndex = textIndex(renderer, 'Older plain thread');

    expect(corruptIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(corruptIndex).toBeLessThan(olderIndex);

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const dayLabels = allText
      .filter(
        (node) =>
          typeof node.props.children === 'string' && node.props.children.startsWith('─── '),
      )
      .map((node) => node.props.children as string);

    expect(dayLabels).toEqual([
      '─── Today ───',
      `─── ${formatDayLabel(olderCreatedAt)} ───`,
    ]);
  });

  // Grouped on ACTIVITY: a thread created days ago whose last reply landed
  // today sits under "Today" — one header, and no section row, since there is
  // only one group.
  it('renders one activity-day header and no section row when activity and creation differ', () => {
    const createdAt = nowTs - 3 * DAY;
    setThreads(
      {
        'thread-bumped': {
          ...baseThread,
          id: 'thread-bumped',
          title: 'Bumped thread',
          createdAt,
          lastReplyAt: nowTs,
          replyCount: 1,
        },
      },
      ['thread-bumped'],
    );

    const renderer = renderThreadsScreen();
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

// ---------------------------------------------------------------------------
// getThreadState — per-thread unread rule (#329). The exhaustive unit coverage,
// including the NaN/Infinity activity cases, lives in
// src/utils/__tests__/threadState.test.ts; these keep the screen's own
// expectation of the rule visible next to the rows that render it.
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
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
  });
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

  // #927: the server leaves imported threads out of the orbit's unread_count,
  // so a dotted import row would sit next to an orbit badge of 0.
  it('returns read for an unreplied import, however new, with a native control', () => {
    const imported = makeThread({ isImport: true, createdAt: 30_000, lastReplyAt: null });
    expect(getThreadState(imported, {}, 25_000)).toBe('read');
    // Identical timestamps, not an import.
    expect(
      getThreadState(makeThread({ createdAt: 30_000, lastReplyAt: null }), {}, 25_000),
    ).toBe('unread');
  });

  it('returns unread for an import whose REPLY is newer than the watermark', () => {
    const replied = makeThread({ isImport: true, createdAt: 30_000, lastReplyAt: 28_000 });
    expect(getThreadState(replied, {}, 25_000)).toBe('unread');
    expect(getThreadState(replied, {}, 29_000)).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Block filtering — list mode + search mode
// ---------------------------------------------------------------------------

describe('ThreadsScreen — block filtering', () => {
  const now = Date.now();

  const threadByBlocked: Thread = makeThreadFixture({
    id: 'thread-blocked',
    conversationId: 'group-1',
    authorId: 'u-blocked',
    authorUsername: 'blockedUser',
    title: 'Blocked user thread',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  });

  const threadByOk: Thread = makeThreadFixture({
    id: 'thread-ok',
    conversationId: 'group-1',
    authorId: 'u-ok',
    authorUsername: 'okUser',
    title: 'Allowed user thread',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  });

  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {
        'thread-blocked': threadByBlocked,
        'thread-ok': threadByOk,
      },
      threadIdsByConversation: {
        'group-1': ['thread-blocked', 'thread-ok'],
      },
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

  it('hides threads authored by blocked users from the thread list', () => {
    mockBlockedSet = new Set(['u-blocked']);
    const renderer = renderThreadsScreen();

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const blockedTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Blocked user thread',
    );
    expect(blockedTitle).toBeUndefined();
  });

  it('renders threads from non-blocked authors when blockedSet is non-empty', () => {
    mockBlockedSet = new Set(['u-blocked']);
    const renderer = renderThreadsScreen();

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const okTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Allowed user thread',
    );
    expect(okTitle).toBeDefined();
  });

  it('excludes blocked authors\' threads from FTS5 search results', () => {
    mockBlockedSet = new Set(['u-blocked']);
    mockSearchState = {
      searchText: 'thread',
      setSearchText: jest.fn(),
      resultThreadIds: ['thread-blocked', 'thread-ok'],
      isSearching: true,
      clearSearch: jest.fn(),
    };

    const renderer = renderThreadsScreen();

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const blockedTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Blocked user thread',
    );
    const okTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Allowed user thread',
    );
    expect(blockedTitle).toBeUndefined();
    expect(okTitle).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Group-key failures on the read surface (#912)
// ---------------------------------------------------------------------------

describe('ThreadsScreen — group key (#912)', () => {
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
    const renderer = renderThreadsScreen();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    return renderer;
  }

  async function rerender(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => {
      renderer.update(
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
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  function find(renderer: ReactTestRenderer, testID: string): number {
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

    expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);
    const rendered = texts(renderer);
    expect(rendered).toContain(PENDING_NOTICE);
    // An undecryptable orbit is not an empty one: no box, no CTA.
    expect(rendered.join('\n')).not.toContain('No threads yet');
    expect(rendered).not.toContain('New Thread');
    expect(find(renderer, 'group-key-pending-body')).toBeGreaterThan(0);
  });

  it('shows the outcome copy in place of the empty state', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('refused'));

    const renderer = await render();

    expect(find(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);
    const rendered = texts(renderer);
    expect(rendered).toContain(UNREADABLE);
    expect(rendered.join('\n')).not.toContain('No threads yet');
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
  });

  // #937: past the 24h bound the crypto layer stops raising PendingWrapError
  // and raises the unwrap error with `stale_pending` instead. "Another member
  // is re-sending it" has stopped being a promise anyone can keep, so the
  // transient banner must come DOWN and the terminal copy take the body.
  it('shows the unreadable copy, not the pending banner, once the wrap is stale', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('stale_pending'));

    const renderer = await render();

    expect(find(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);
    const rendered = texts(renderer);
    expect(rendered).toContain(UNREADABLE);
    expect(rendered.join('\n')).not.toContain('No threads yet');
    // Not the transient state: no banner, no blank "key is on its way" body,
    // and none of the re-sending wording anywhere on screen.
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
    expect(find(renderer, 'group-key-pending-body')).toBe(0);
    expect(rendered).not.toContain(PENDING_NOTICE);
    expect(rendered.join('\n')).not.toContain('being re-sent');
  });

  it('keeps the normal empty state for a failure that is not a key failure', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));

    const renderer = await render();

    expect(texts(renderer).join('\n')).toContain('No threads yet');
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
    expect(find(renderer, 'group-key-failure-notice')).toBe(0);
  });

  it('reloads and clears the notice when the generation is bumped (D11)', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());

    const renderer = await render();
    expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);

    // The heal lands: handleWrappedKeyDelivered fetched the delivered key and
    // bumped the counter. The OPEN screen reloads itself (B2).
    mockKeyGeneration = 1;
    await rerender(renderer);

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No threads yet');
  });

  it('does not reload while the generation is unchanged', async () => {
    const renderer = await render();
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);

    await rerender(renderer);

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);
  });

  // The screen stays MOUNTED across an orbit switch, so before the reset the
  // undecryptable orbit's state sat over the next one: its New Thread CTA was
  // gone, and if that orbit's own load then failed for a non-key reason the
  // flags never cleared, because they clear only on a success.
  it('drops the notice and restores the New Thread CTA when the orbit changes', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('refused'));

    const renderer = await render();
    expect(find(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);

    // Switch orbits. group-2's own load then fails for a NON-key reason,
    // which is the case that made this permanent: that path leaves the flags
    // alone, so only the switch itself can clear them.
    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));
    mockActiveConversationId = 'group-2';
    await rerender(renderer);

    expect(find(renderer, 'group-key-failure-notice')).toBe(0);
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
    const rendered = texts(renderer);
    expect(rendered.join('\n')).toContain('No threads yet');
    expect(rendered).toContain('New Thread');
    // An orbit CHANGE is an open: the previous orbit's walked tail goes with
    // its cursor (#923).
    expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-2', { tail: 'drop' });
  });

  // The ugly half of the same bug: `loadThreadsForGroup` is not cancellable,
  // so orbit A's rejection can land AFTER the user has moved to orbit B. Its
  // verdict must be dropped, not written onto B.
  it('ignores a rejection that lands after the user switched orbits', async () => {
    mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());

    // B's load fails for a non-key reason, so it neither sets nor clears the
    // key flags: whatever A's late rejection writes is what stays on screen.
    mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));

    // Rendered but NOT flushed: A's load is still in flight.
    const renderer = renderThreadsScreen();
    mockActiveConversationId = 'group-2';
    await rerender(renderer);

    // A's pending rejection has now settled, against the wrong orbit.
    expect(find(renderer, 'group-key-pending-banner')).toBe(0);
    expect(find(renderer, 'group-key-pending-body')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No threads yet');
  });

  // -------------------------------------------------------------------------
  // Pull-to-refresh re-classification (#940)
  // -------------------------------------------------------------------------

  /**
   * #940: `handleRefresh` used to swallow EVERY error and never clear on
   * success, so the pull that was meant to re-classify a key verdict left the
   * old one on screen — most visibly after #938's 24h bound, where the
   * "being re-sent" banner outlived the re-send it kept promising.
   *
   * These cases need ROWS. The RefreshControl only exists on the FlatList
   * branch (`listRows` non-empty); an orbit with nothing in it renders an
   * empty state with nothing to pull. That also means the failure NOTICE has
   * nowhere to render while rows are up — it replaces the empty state, by
   * design, because visible stale content is the better answer than an
   * explanation nobody asked for. So with rows the observable effect of a
   * re-classification is the BANNER coming down; the first case checks the
   * recorded verdict itself by emptying the orbit once the pull has settled.
   */
  describe('pull-to-refresh (#940)', () => {
    const now = Date.now();
    const SEEDED_TITLE = 'Seeded thread';

    /** The threads slice, with or without this orbit's one row. */
    function threadsSlice(withRows: boolean) {
      const thread: Thread = makeThreadFixture({
        id: 'thread-1',
        conversationId: 'group-1',
        authorId: 'user-1',
        authorUsername: 'alice',
        title: SEEDED_TITLE,
        body: null,
        contentType: 'text',
        pinned: false,
        replyCount: 0,
        lastReplyAt: now,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'synced',
      });
      return {
        threads: withRows ? ({ 'thread-1': thread } as Record<string, Thread>) : {},
        threadIdsByConversation: withRows ? { 'group-1': ['thread-1'] } : {},
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
      };
    }

    function setRows(withRows: boolean): void {
      const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
      storesMock.useThreads.mockReturnValue(threadsSlice(withRows));
    }

    beforeEach(() => {
      setRows(true);
    });

    // Put the surrounding empty-orbit state back, so the cases above (which
    // all assert on the empty state) are unaffected by the seeding here.
    afterEach(() => {
      setRows(false);
    });

    function flush(): Promise<void> {
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    /**
     * The list's `onRefresh`, via the ONE host node that carries both `data`
     * and a `refreshControl`. The exactly-one assertion is the point: if a
     * second list ever renders here (a search list, a nested FlatList), the
     * helper must fail rather than silently pull on whichever came first.
     */
    function refreshHandler(renderer: ReactTestRenderer): () => Promise<void> {
      const nodes = renderer.root.findAll(
        (n) =>
          typeof n.type === 'string' &&
          Array.isArray(n.props.data) &&
          n.props.refreshControl != null,
      );
      expect(nodes).toHaveLength(1);
      return nodes[0].props.refreshControl.props.onRefresh as () => Promise<void>;
    }

    /** Pull, and let the handler and its state writes settle. */
    async function pullToRefresh(renderer: ReactTestRenderer): Promise<void> {
      const onRefresh = refreshHandler(renderer);
      await act(async () => {
        await onRefresh();
        await flush();
      });
    }

    /**
     * A refresh whose rejection is settled BY HAND. `mockRejectedValueOnce`
     * settles on the first microtask, which is too early for the two
     * late-settle cases: those need the orbit switch / the unmount to happen
     * while the pull is still in flight. Still one-shot — the next call after
     * it falls back to the suite's `mockResolvedValue([])`.
     */
    function deferNextLoad(): { reject: (e: unknown) => void } {
      const box = { reject: (_e: unknown): void => {} };
      mockLoadThreadsForGroup.mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, rej) => {
            box.reject = rej;
          }),
      );
      return box;
    }

    // THE #940 case. The pending banner is up, the pull comes back
    // `stale_pending` (#938: the wait is over, the key is not coming), and the
    // banner must come DOWN. Against the old swallow-everything handler the
    // first expectation below fails: the banner survived the pull.
    it('takes the pending banner down when the refresh comes back stale_pending', async () => {
      mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());
      const renderer = await render();
      expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);

      mockLoadThreadsForGroup.mockRejectedValueOnce(unwrapFailure('stale_pending'));
      await pullToRefresh(renderer);

      expect(find(renderer, 'group-key-pending-banner')).toBe(0);
      // The rows the pull was issued over are untouched: a key verdict never
      // costs the user content that is already decrypted and on screen.
      expect(texts(renderer)).toContain(SEEDED_TITLE);

      // And the verdict the pull recorded is the failure copy, not a cleared
      // state. That notice replaces the EMPTY state, so it has somewhere to
      // render only once this orbit has no rows left — which is also what the
      // user sees on the next cold open of an orbit they cannot decrypt.
      setRows(false);
      await rerender(renderer);
      expect(find(renderer, 'group-key-failure-notice')).toBeGreaterThan(0);
      expect(texts(renderer)).toContain(UNREADABLE);
    });

    // The happy half: the peer's re-send landed, the pull succeeds, and the
    // banner must go. The old handler cleared nothing on success either, so
    // the banner sat there until the screen was navigated away from.
    it('clears the pending banner when the refresh succeeds', async () => {
      mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());
      const renderer = await render();
      expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);

      // Falls through to the suite default: resolves with no threads.
      await pullToRefresh(renderer);

      expect(find(renderer, 'group-key-pending-banner')).toBe(0);
      expect(find(renderer, 'group-key-failure-notice')).toBe(0);
      expect(texts(renderer)).toContain(SEEDED_TITLE);
    });

    // The guard on the other side: a dropped connection is not a verdict. A
    // refresh that fails for a non-key reason must leave the real one alone —
    // this is what fails if #940 is ever "fixed" by clearing unconditionally.
    it('keeps the pending banner when the refresh fails for a non-key reason', async () => {
      mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());
      const renderer = await render();
      expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);

      mockLoadThreadsForGroup.mockRejectedValueOnce(new Error('network down'));
      await pullToRefresh(renderer);

      expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);
      expect(find(renderer, 'group-key-failure-notice')).toBe(0);
      expect(texts(renderer)).toContain(SEEDED_TITLE);
    });

    // `loadThreadsForGroup` is not cancellable, so a pull on orbit A can
    // settle after the user has moved to orbit B. The refresh reads the store
    // LIVE at settle time for exactly this: A's verdict is dropped, never
    // written onto B.
    it('writes nothing when a refresh rejection lands after an orbit switch', async () => {
      const renderer = await render();

      const deferred = deferNextLoad();
      let settled!: Promise<void>;
      await act(async () => {
        settled = refreshHandler(renderer)();
        await flush();
      });

      // Switch mid-pull. group-2 has no rows here, and its own load resolves,
      // so nothing but A's late rejection could put a notice on screen.
      mockActiveConversationId = 'group-2';
      await rerender(renderer);

      await act(async () => {
        deferred.reject(unwrapFailure('refused'));
        await settled;
        await flush();
      });

      expect(find(renderer, 'group-key-failure-notice')).toBe(0);
      expect(find(renderer, 'group-key-pending-banner')).toBe(0);
      expect(texts(renderer).join('\n')).toContain('No threads yet');
    });

    // The other thing a pull can outlive: the screen itself. The orbit check
    // is a render-synced mirror of the store and cannot see an unmount, hence
    // the separate mounted ref. Nothing is written and nothing throws.
    it('writes nothing and does not throw when a refresh rejection lands after unmount', async () => {
      mockLoadThreadsForGroup.mockRejectedValueOnce(pendingWrap());
      const renderer = await render();
      expect(find(renderer, 'group-key-pending-banner')).toBeGreaterThan(0);

      const deferred = deferNextLoad();
      let settled!: Promise<void>;
      await act(async () => {
        settled = refreshHandler(renderer)();
        await flush();
      });

      act(() => {
        renderer.unmount();
      });

      await act(async () => {
        deferred.reject(unwrapFailure('stale_pending'));
        await flush();
      });

      // The handler swallows the rejection it decided not to act on: no
      // unhandled rejection escapes the pull, and the tree stays torn down.
      await expect(settled).resolves.toBeUndefined();
      expect(renderer.toJSON()).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Load more — the thread-list cursor walk (#923)
// ---------------------------------------------------------------------------

/**
 * The hook under the screen is REAL in these cases: the mocked seams are the
 * three `threadService` functions and the paging slot `threadListWalk` would
 * have written. What is being pinned is the SCREEN's wiring — which gesture
 * reaches the walk, which option each load passes, and what the member sees
 * when a page fails or renders nothing.
 */
describe('ThreadsScreen — load more (#923)', () => {
  const now = Date.now();

  /** Seed `count` rows into the threads slice (0 = an orbit with no rows). */
  function setRows(count: number): void {
    const threads: Record<string, Thread> = {};
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `thread-${i}`;
      ids.push(id);
      threads[id] = makeThreadFixture({
        id,
        conversationId: 'group-1',
        authorId: 'user-1',
        authorUsername: 'alice',
        title: `Thread ${i}`,
        body: null,
        createdAt: now - i * 1000,
        updatedAt: now - i * 1000,
        lastReplyAt: null,
      });
    }
    const storesMock = jest.requireMock('../../stores') as { useThreads: jest.Mock };
    storesMock.useThreads.mockReturnValue({
      threads,
      threadIdsByConversation: count > 0 ? { 'group-1': ids } : {},
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
  }

  function flush(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async function render(): Promise<ReactTestRenderer> {
    const renderer = renderThreadsScreen();
    await act(async () => {
      await flush();
    });
    return renderer;
  }

  async function rerender(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(ThreadsScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<
              typeof ThreadsScreen
            >['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof ThreadsScreen>['route'],
          }),
        ),
      );
    });
    await act(async () => {
      await flush();
    });
  }

  function find(renderer: ReactTestRenderer, testID: string): number {
    return renderer.root.findAll((node) => node.props.testID === testID).length;
  }

  function texts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children)
      .filter((c): c is string => typeof c === 'string');
  }

  /**
   * The ONE list node — keyed on `data` + `refreshControl`, because this
   * screen's FlatList is the only node carrying both (the ThreadDetail
   * helper's `onEndReached` key would now match here too, but the pair stays
   * the stricter test).
   */
  function listProps(renderer: ReactTestRenderer): Record<string, unknown> {
    const nodes = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        Array.isArray(n.props.data) &&
        n.props.refreshControl != null,
    );
    expect(nodes).toHaveLength(1);
    return nodes[0].props as Record<string, unknown>;
  }

  async function endReach(renderer: ReactTestRenderer, times = 1): Promise<void> {
    const onEndReached = listProps(renderer).onEndReached as () => void;
    await act(async () => {
      for (let i = 0; i < times; i++) onEndReached();
      await flush();
    });
  }

  /** The footer's "Load more" row, by the component node that owns onPress. */
  function retryRow(renderer: ReactTestRenderer): { onPress: () => void } | null {
    const nodes = renderer.root.findAll(
      (n) => n.props.testID === 'thread-list-footer-retry' && typeof n.props.onPress === 'function',
    );
    return nodes.length === 0 ? null : (nodes[0].props as { onPress: () => void });
  }

  beforeEach(() => {
    setRows(3);
    mockThreadListPaging = {
      hasMore: true,
      loadingMore: false,
      loadMoreFailed: false,
      totalCount: 100,
    };
  });

  afterEach(() => {
    setRows(0);
  });

  it('walks one page per end-reach, however often the list fires it', async () => {
    // A page that adds ids with no filter active IS growth, so the loop stops
    // after one: what is pinned here is the ref guard, not the loop.
    mockLoadMoreThreadsForGroup.mockResolvedValue({
      status: 'loaded',
      newIdCount: 30,
      hasMore: true,
    });
    const renderer = await render();
    await endReach(renderer, 3);

    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledTimes(1);
    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledWith('group-1');
  });

  it('keeps paging while pages add no ids, and stops when one does', async () => {
    mockLoadMoreThreadsForGroup
      .mockResolvedValueOnce({ status: 'loaded', newIdCount: 0, hasMore: true })
      .mockResolvedValueOnce({ status: 'loaded', newIdCount: 0, hasMore: true })
      .mockResolvedValueOnce({ status: 'loaded', newIdCount: 12, hasMore: true });

    const renderer = await render();
    await endReach(renderer);

    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledTimes(3);
  });

  it('turns a failed page into a tappable Load more row that retries', async () => {
    mockLoadMoreThreadsForGroup.mockRejectedValueOnce(new Error('network down'));

    const renderer = await render();
    await endReach(renderer);

    const row = retryRow(renderer);
    expect(row).not.toBeNull();
    // A real frame, not hitSlop: the footer's parent is short (#888).
    const frame = renderer.root.findAll(
      (n) => n.props.testID === 'thread-list-footer-retry' && n.props.accessibilityRole === 'button',
    );
    expect(frame.length).toBeGreaterThan(0);

    mockLoadMoreThreadsForGroup.mockResolvedValue({
      status: 'loaded',
      newIdCount: 20,
      hasMore: true,
    });
    await act(async () => {
      row?.onPress();
      await flush();
    });

    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(retryRow(renderer)).toBeNull();
  });

  it('a 429 stops chaining and offers the retry', async () => {
    mockLoadMoreThreadsForGroup.mockResolvedValue({
      status: 'rate-limited',
      newIdCount: 0,
      hasMore: true,
    });

    const renderer = await render();
    await endReach(renderer);

    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledTimes(1);
    expect(retryRow(renderer)).not.toBeNull();
  });

  /**
   * THE case this branch exists for: every author on the head page is
   * blocked, so the orbit renders nothing while the server says there are 100
   * threads. "No threads yet" would be a lie, and the list is not mounted, so
   * the hook's own auto-fill is the only thing that can walk.
   */
  it('shows the walk instead of the empty state when a head page renders nothing', async () => {
    setRows(0);
    const renderer = await render();

    expect(find(renderer, 'threads-paging-empty')).toBeGreaterThan(0);
    expect(texts(renderer).join('\n')).not.toContain('No threads yet');
    expect(texts(renderer)).not.toContain('New Thread');
    expect(mockLoadMoreThreadsForGroup).toHaveBeenCalledWith('group-1');
    // The follow-up loop ran to its cap without the list growing, so the
    // member is left something to tap rather than a spinner forever.
    expect(retryRow(renderer)).not.toBeNull();
  });

  it('still shows the create-first empty state when there is nothing more', async () => {
    setRows(0);
    mockThreadListPaging = { ...mockThreadListPaging, hasMore: false };
    const renderer = await render();

    expect(find(renderer, 'threads-paging-empty')).toBe(0);
    expect(texts(renderer).join('\n')).toContain('No threads yet');
    expect(mockLoadMoreThreadsForGroup).not.toHaveBeenCalled();
  });

  it('does not walk while the screen is searching', async () => {
    mockSearchState = { ...mockSearchState, isSearching: true, resultThreadIds: ['thread-0'] };
    const renderer = await render();
    await endReach(renderer);

    expect(mockLoadMoreThreadsForGroup).not.toHaveBeenCalled();
    expect(listProps(renderer).ListFooterComponent).toBeNull();
  });

  describe('which load keeps the walked tail', () => {
    it('drops it when the orbit changes and keeps it on a key heal', async () => {
      const renderer = await render();
      expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-1', { tail: 'drop' });

      // A heal bump re-reads the SAME orbit's head page: dropping the tail
      // here would yank the member back to the top of a list they walked.
      mockKeyGeneration = 1;
      await rerender(renderer);
      expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-1', { tail: 'keep' });

      mockActiveConversationId = 'group-2';
      await rerender(renderer);
      expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-2', { tail: 'drop' });
    });

    it('pull-to-refresh keeps it', async () => {
      const renderer = await render();
      const refreshControl = listProps(renderer).refreshControl as {
        props: { onRefresh: () => Promise<void> };
      };

      await act(async () => {
        await refreshControl.props.onRefresh();
        await flush();
      });

      expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-1', { tail: 'keep' });
    });
  });

  describe('leaving the conversation', () => {
    it('leaves the OLD orbit when the member switches', async () => {
      const renderer = await render();
      expect(mockLeaveThreadList).not.toHaveBeenCalled();

      mockActiveConversationId = 'group-2';
      await rerender(renderer);

      expect(mockLeaveThreadList).toHaveBeenCalledWith('group-1');
    });

    it('leaves on unmount', async () => {
      const renderer = await render();
      act(() => {
        renderer.unmount();
      });

      expect(mockLeaveThreadList).toHaveBeenCalledWith('group-1');
    });
  });

  describe('search', () => {
    it('hydrates result entities the walk trim dropped', async () => {
      mockSearchState = {
        ...mockSearchState,
        isSearching: true,
        resultThreadIds: ['thread-0', 'trimmed-1'],
      };
      await render();

      expect(mockEnsureThreadEntitiesCached).toHaveBeenCalledWith(['thread-0', 'trimmed-1']);
    });

    it('renders a result whose entity is in the map and skips one that is not', async () => {
      mockSearchState = {
        ...mockSearchState,
        isSearching: true,
        resultThreadIds: ['thread-1', 'trimmed-1'],
      };
      const renderer = await render();

      expect(texts(renderer)).toContain('Thread 1');
    });

    it('scrolls to the top on ENTERING search, and not on leaving it', async () => {
      const scrollSpy = jest.fn();
      const renderer = await render();
      // The list instance the screen holds a ref to.
      const instance = (
        renderer.root.findAll(
          (n) => typeof n.type !== 'string' && typeof n.props.data !== 'undefined',
        )[0] as unknown as { instance: { scrollToOffset?: unknown } | null }
      ).instance;
      if (instance && typeof instance === 'object') {
        (instance as { scrollToOffset: unknown }).scrollToOffset = scrollSpy;
      }

      mockSearchState = { ...mockSearchState, isSearching: true, resultThreadIds: ['thread-1'] };
      await rerender(renderer);
      const scrollsOnEnter = scrollSpy.mock.calls.length;

      mockSearchState = { ...mockSearchState, isSearching: false, resultThreadIds: [] };
      await rerender(renderer);

      // Entering may scroll; LEAVING must not add one — a walked list's
      // position survives the search overlay (#923).
      expect(scrollSpy.mock.calls.length).toBe(scrollsOnEnter);
    });
  });

  it('anchors the viewport and does not clip subviews on Android', async () => {
    const renderer = await render();
    const props = listProps(renderer);

    expect(props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    expect(props.onEndReachedThreshold).toBe(0.3);
    // Platform in jest is ios: the pair ships together there.
    expect(props.removeClippedSubviews).toBe(true);
  });
});
