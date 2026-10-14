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
import type { Thread } from '../../types/store';

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
};});

import { toggleMute } from '../../services/notificationSettingsSync';
const mockToggleMute = toggleMute as jest.Mock;

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

  const baseThread = {
    id: 'thread-base',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'Base thread',
    body: null,
    contentType: 'text' as const,
    pinned: false,
    replyCount: 0,
    lastReplyAt: null as number | null,
    createdAt: nowTs,
    updatedAt: nowTs,
    syncStatus: 'synced' as const,
  };

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
        } as Thread,
        'thread-new': {
          ...baseThread,
          id: 'thread-new',
          title: 'Newer quiet thread',
          createdAt: nowTs - 60_000,
          lastReplyAt: null,
        } as Thread,
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
        } as Thread,
        'thread-older': {
          ...baseThread,
          id: 'thread-older',
          title: 'Older plain thread',
          createdAt: olderCreatedAt,
          lastReplyAt: null,
        } as Thread,
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
        } as Thread,
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

// ---------------------------------------------------------------------------
// Block filtering — list mode + search mode
// ---------------------------------------------------------------------------

describe('ThreadsScreen — block filtering', () => {
  const now = Date.now();

  const threadByBlocked: Thread = {
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
  } as Thread;

  const threadByOk: Thread = {
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
  } as Thread;

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
