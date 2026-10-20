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

import { loadThreadsForGroup } from '../../services/threadService';
// #912: the load seam the group-key read-surface cases drive.
const mockLoadThreadsForGroup = loadThreadsForGroup as jest.Mock;

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
    expect(mockLoadThreadsForGroup).toHaveBeenLastCalledWith('group-2');
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
});
