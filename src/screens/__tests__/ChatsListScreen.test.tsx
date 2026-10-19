/**
 * Tests for ChatsListScreen — DM conversation list, empty state, and navigation.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ChatsListScreen } from '../ChatsListScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  loadDmConversations: jest.fn().mockResolvedValue(undefined),
  hydrateContactsFromOrbits: jest.fn().mockResolvedValue(undefined),
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

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
}));

const mockUseConversations = jest.fn();
const mockUseContacts = jest.fn();

// Mutable so a test can render a muted row (#449).
let mockMutedTargets: Record<string, string> = {};

jest.mock('../../services/notificationSettingsSync', () => ({
  toggleMute: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../stores', () => {
  const getState = () => ({ mutedTargets: mockMutedTargets });
  return {
    useConversations: (...args: unknown[]) => mockUseConversations(...args),
    useContacts: (...args: unknown[]) => mockUseContacts(...args),
    useAppStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState },
    ),
  };
});

jest.mock('../../utils/avatarUrl', () => ({
  getAvatarUrl: jest.fn(() => null),
}));

// The real hook reaches `useAppStore` → MMKV/nitro, which cannot load under
// Jest. Mocked at the module boundary (the ThreadsScreen idiom) so the block
// set stays a plain, test-driven value (#908).
let mockBlockedSet = new Set<string>();
jest.mock('../../hooks/useBlockedSet', () => ({
  useBlockedSet: () => mockBlockedSet,
}));

import { loadDmConversations } from '../../services/conversationService';
const mockLoadDmConversations = loadDmConversations as jest.Mock;

import { toggleMute } from '../../services/notificationSettingsSync';
const mockToggleMute = toggleMute as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();

const emptyConversationsState = {
  conversations: {},
  conversationIds: [],
  activeConversationId: null,
  setConversations: jest.fn(),
  upsertConversation: jest.fn(),
  removeConversation: jest.fn(),
  setActiveConversation: jest.fn(),
  updateUnreadCount: jest.fn(),
  markConversationRead: jest.fn(),
};

const dmConversationsState = {
  ...emptyConversationsState,
  conversations: {
    'dm-1': {
      id: 'dm-1',
      type: 'direct' as const,
      name: 'Bob',
      memberCount: 2,
      active: true,
      lastMessageAt: now - 3600000,
      unreadCount: 0,
      createdAt: now - 7200000,
      updatedAt: now - 3600000,
    },
    'dm-2': {
      id: 'dm-2',
      type: 'direct' as const,
      name: 'Charlie',
      memberCount: 2,
      active: true,
      lastMessageAt: now - 1800000,
      unreadCount: 1,
      createdAt: now - 5000000,
      updatedAt: now - 1800000,
    },
  },
  conversationIds: ['dm-1', 'dm-2'],
};

// ---------------------------------------------------------------------------
// Blocked-peer fixtures (#908)
// ---------------------------------------------------------------------------

/** The peer of `dm-3` — the only id these tests ever block. */
const BLOCKED_PEER_ID = 'user-dave';

/** A DM row as written since #908: the peer id is on the row itself. */
const dmRowWithPeerId = {
  id: 'dm-3',
  type: 'direct' as const,
  name: 'Dave',
  memberCount: 2,
  active: true,
  lastMessageAt: now - 600000,
  // Non-zero so the hidden row's unread badge can be asserted away.
  unreadCount: 5,
  createdAt: now - 900000,
  updatedAt: now - 600000,
  peerUserId: BLOCKED_PEER_ID,
};

/**
 * The same row as persisted BEFORE #908 — no `peerUserId`, so the only path to
 * the peer is the contact reverse-scan in `resolveDmPeerId`.
 */
const dmRowWithoutPeerId = {
  id: 'dm-3',
  type: 'direct' as const,
  name: 'Dave',
  memberCount: 2,
  active: true,
  lastMessageAt: now - 600000,
  unreadCount: 5,
  createdAt: now - 900000,
  updatedAt: now - 600000,
};

const dmsWithPeerIdState = {
  ...dmConversationsState,
  conversations: {
    ...dmConversationsState.conversations,
    'dm-3': dmRowWithPeerId,
  },
  conversationIds: ['dm-1', 'dm-2', 'dm-3'],
};

const dmsWithLegacyRowState = {
  ...dmConversationsState,
  conversations: {
    ...dmConversationsState.conversations,
    'dm-3': dmRowWithoutPeerId,
  },
  conversationIds: ['dm-1', 'dm-2', 'dm-3'],
};

/** Dave, reachable only through `conversationIds` — the fallback path. */
const contactsWithDave = {
  contacts: {
    [BLOCKED_PEER_ID]: {
      id: BLOCKED_PEER_ID,
      username: 'dave',
      displayName: 'Dave',
      avatarPath: null,
      conversationIds: ['dm-3'],
    },
  },
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

const mockRoute = {
  key: 'ChatsList',
  name: 'ChatsList' as const,
  params: undefined,
};

function screenElement(): React.ReactElement {
  return React.createElement(
    SafeAreaProvider,
    { initialMetrics: safeAreaMetrics },
    React.createElement(
      ThemeProvider,
      { colorSchemeOverride: 'light' },
      React.createElement(ChatsListScreen, {
        navigation: mockNavigation as unknown as React.ComponentProps<typeof ChatsListScreen>['navigation'],
        route: mockRoute as unknown as React.ComponentProps<typeof ChatsListScreen>['route'],
      }),
    ),
  );
}

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(screenElement());
  });
  return renderer;
}

/**
 * Re-render in place. The hook mocks hold plain values with no subscription, so
 * a change to `mockBlockedSet` reaches the screen on the next render pass —
 * which is what a real `blockedUserIds` store write would trigger. Keeping the
 * same renderer is the point: a fresh mount would re-run the load effect and
 * make "no extra loads on unblock" unfalsifiable.
 */
function rerenderScreen(renderer: ReactTestRenderer): void {
  act(() => {
    renderer.update(screenElement());
  });
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
  mockMutedTargets = {};
  mockBlockedSet = new Set<string>();
  mockUseConversations.mockReturnValue(emptyConversationsState);
  mockUseContacts.mockReturnValue({ contacts: {} });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatsListScreen — rendering', () => {
  it('has testID "chats-list-screen"', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'chats-list-screen')).not.toThrow();
  });

  it('renders the search bar with placeholder', () => {
    const renderer = renderScreen();
    const inputs = renderer.root.findAllByType('TextInput' as unknown as React.ComponentType);
    const searchInput = inputs.find(
      (node) => node.props.placeholder === 'Search contacts...',
    );
    expect(searchInput).toBeDefined();
  });

  it('renders empty state when there are no DM conversations', () => {
    const renderer = renderScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No chats yet'),
    );
    expect(emptyNode).toBeDefined();
  });

  it('renders conversation list when DMs exist', () => {
    mockUseConversations.mockReturnValue(dmConversationsState);
    const renderer = renderScreen();

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const bobNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Bob',
    );
    expect(bobNode).toBeDefined();
  });
});

describe('ChatsListScreen — data loading', () => {
  it('calls loadDmConversations on mount', async () => {
    await act(async () => {
      renderScreen();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });
});

describe('ChatsListScreen — navigation', () => {
  it('navigates to ChatDetail when a conversation item is pressed', () => {
    mockUseConversations.mockReturnValue(dmConversationsState);
    const renderer = renderScreen();

    // ChatItem renders a TouchableOpacity with accessibilityLabel="Chat with {name}"
    const chatItem = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Chat with Bob',
    );
    expect(chatItem.length).toBeGreaterThan(0);

    act(() => {
      // handlePress is a closure — call with no argument; it passes conversationId internally
      chatItem[0].props.onPress();
    });

    expect(mockNavigation.push).toHaveBeenCalledWith('ChatDetail', {
      conversationId: 'dm-1',
      recipientName: 'Bob',
    });
  });

  it('navigates to NewChat when the + header button is pressed', () => {
    const renderer = renderScreen();
    const allButtons = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'New chat',
    );
    expect(allButtons.length).toBeGreaterThan(0);

    act(() => {
      allButtons[0].props.onPress();
    });

    expect(mockNavigation.navigate).toHaveBeenCalledWith('NewChat');
  });
});

// ---------------------------------------------------------------------------
// Per-conversation muting (#449)
// ---------------------------------------------------------------------------

describe('ChatsListScreen — mute', () => {
  /**
   * A chat row's pressable, addressed by recipient name — rows are sorted by
   * lastMessageAt, so index 0 is Charlie, not Bob.
   */
  function chatRow(renderer: ReactTestRenderer, name = 'Bob'): ReactTestInstance {
    const rows = renderer.root.findAll(
      (n) =>
        n.props.accessibilityHint === 'Long press for notification options' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith(`Chat with ${name}`),
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  /** Host-only node count — findAll matches both the composite and its host. */
  function countMutedIndicators(renderer: ReactTestRenderer): number {
    return renderer.root.findAll(
      (n) => n.props.testID === 'chat-muted-indicator' && typeof n.type === 'string',
    ).length;
  }

  beforeEach(() => {
    mockUseConversations.mockReturnValue(dmConversationsState);
  });

  it('long-pressing a chat row opens the mute Alert with the conversation name', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderScreen();

    act(() => {
      chatRow(renderer).props.onLongPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Bob',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Mute notifications' }),
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      ]),
    );
    alertSpy.mockRestore();
  });

  it('mutes the conversation as a GROUP target (DMs are groups server-side)', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderScreen();

    act(() => {
      chatRow(renderer).props.onLongPress();
    });
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    act(() => {
      buttons.find((b) => b.text === 'Mute notifications')!.onPress!();
    });

    expect(mockToggleMute).toHaveBeenCalledWith('dm-1', 'group');
    alertSpy.mockRestore();
  });

  it('offers Unmute when the conversation is already muted', () => {
    mockMutedTargets = { 'dm-1': 'group' };
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderScreen();

    act(() => {
      chatRow(renderer).props.onLongPress();
    });

    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string }>;
    expect(buttons.map((b) => b.text)).toContain('Unmute notifications');
    alertSpy.mockRestore();
  });

  it('renders the muted indicator only for muted conversations', () => {
    expect(countMutedIndicators(renderScreen())).toBe(0);

    // dm-1 muted, dm-2 not → exactly one indicator across the two rows
    mockMutedTargets = { 'dm-1': 'group' };
    expect(countMutedIndicators(renderScreen())).toBe(1);
  });

  it('exposes a mute accessibilityAction that fires the same menu', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderScreen();
    const row = chatRow(renderer);

    expect(row.props.accessibilityActions).toEqual([
      { name: 'mute', label: 'Mute notifications' },
    ]);

    act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'mute' } });
    });

    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Blocked DM peers (#908)
// ---------------------------------------------------------------------------

describe('ChatsListScreen — blocked DM peers (#908)', () => {
  /** True when a chat row for `name` is on screen (names render as Text). */
  function hasRowNamed(renderer: ReactTestRenderer, name: string): boolean {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .some((node) => node.props.children === name);
  }

  /** The count rendered inside each unread badge — host nodes only. */
  function unreadBadgeCounts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAll((n) => n.props.testID === 'unread-badge' && typeof n.type === 'string')
      .map((n) =>
        String(
          n.findByType('Text' as unknown as React.ComponentType).props.children,
        ),
      );
  }

  it('hides the DM whose peer is blocked via peerUserId', () => {
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);
    mockBlockedSet = new Set([BLOCKED_PEER_ID]);

    const renderer = renderScreen();

    expect(hasRowNamed(renderer, 'Dave')).toBe(false);
    // Positive control — the other DMs are untouched.
    expect(hasRowNamed(renderer, 'Bob')).toBe(true);
    expect(hasRowNamed(renderer, 'Charlie')).toBe(true);
  });

  it('hides the DM when the peer resolves only through the contact fallback', () => {
    // Pre-#908 row: no `peerUserId`, so the peer comes from the contact's
    // `conversationIds`. Without the fallback this row would stay visible.
    mockUseConversations.mockReturnValue(dmsWithLegacyRowState);
    mockUseContacts.mockReturnValue(contactsWithDave);

    // Same fixture, nothing blocked: the row IS rendered — so its absence
    // below cannot be an artifact of the pre-#908 row shape.
    expect(hasRowNamed(renderScreen(), 'Dave')).toBe(true);

    mockBlockedSet = new Set([BLOCKED_PEER_ID]);
    const renderer = renderScreen();

    expect(hasRowNamed(renderer, 'Dave')).toBe(false);
    expect(hasRowNamed(renderer, 'Bob')).toBe(true);
  });

  it('renders no unread badge for the hidden row', () => {
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);
    mockBlockedSet = new Set([BLOCKED_PEER_ID]);

    const renderer = renderScreen();

    // dm-3 carries unreadCount 5, dm-2 carries 1: the 5 must be gone with the
    // row, and the 1 proves the walker actually saw the rendered badges.
    expect(unreadBadgeCounts(renderer)).toEqual(['1']);
  });

  it('keeps every DM visible when nothing is blocked', () => {
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);

    const renderer = renderScreen();

    expect(hasRowNamed(renderer, 'Dave')).toBe(true);
    expect(hasRowNamed(renderer, 'Bob')).toBe(true);
    expect(unreadBadgeCounts(renderer)).toEqual(['5', '1']);
  });

  it('restores the row on unblock without reloading the DM list', () => {
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);
    mockBlockedSet = new Set([BLOCKED_PEER_ID]);
    const renderer = renderScreen();
    expect(hasRowNamed(renderer, 'Dave')).toBe(false);

    mockBlockedSet = new Set<string>();
    rerenderScreen(renderer);

    expect(hasRowNamed(renderer, 'Dave')).toBe(true);
    // The row comes back from the store slice already held — unblocking must
    // not depend on a refetch.
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });

  it('shows the plain "No chats yet" empty state when every DM is hidden', () => {
    // Product call (#908): an all-hidden list reads exactly like a brand new
    // account. No count, no "some conversations are hidden" hint — nothing
    // that would tell the user (or anyone looking over their shoulder) that a
    // blocked conversation exists.
    const allBlockedState = {
      ...emptyConversationsState,
      conversations: {
        'dm-1': { ...dmConversationsState.conversations['dm-1'], peerUserId: 'user-bob' },
        'dm-2': { ...dmConversationsState.conversations['dm-2'], peerUserId: 'user-charlie' },
      },
      conversationIds: ['dm-1', 'dm-2'],
    };
    mockUseConversations.mockReturnValue(allBlockedState);

    // Positive control: unblocked, the same fixture renders both rows and no
    // empty state at all.
    const before = renderScreen();
    expect(hasRowNamed(before, 'Bob')).toBe(true);
    expect(hasRowNamed(before, 'Charlie')).toBe(true);

    mockBlockedSet = new Set(['user-bob', 'user-charlie']);
    const renderer = renderScreen();

    const texts = renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children)
      .filter((c): c is string => typeof c === 'string');

    expect(texts).toContain('No chats yet\nStart a conversation!');
    expect(texts).toContain('New Chat');
    expect(hasRowNamed(renderer, 'Bob')).toBe(false);
    expect(hasRowNamed(renderer, 'Charlie')).toBe(false);
    // Nothing anywhere on screen alludes to the hidden rows.
    expect(texts.some((t) => /block|hidden/i.test(t))).toBe(false);
  });

  it('passes the peerUserId-derived recipientId to ChatDetail', () => {
    // The hint ChatDetail feeds back into `resolveDmPeerId` has to come from
    // the SAME resolver the hide filter uses. The pressed row carries
    // `peerUserId` and the contacts map is empty, so the old local
    // `Object.values(contacts).find(...)` scan this replaced would have found
    // nothing and sent `recipientId: undefined`.
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);
    mockUseContacts.mockReturnValue({ contacts: {} });
    const renderer = renderScreen();

    const row = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Chat with Dave');
    expect(row.length).toBeGreaterThan(0);

    act(() => {
      row[0].props.onPress();
    });

    expect(mockNavigation.push).toHaveBeenCalledWith('ChatDetail', {
      conversationId: 'dm-3',
      recipientName: 'Dave',
      recipientId: BLOCKED_PEER_ID,
    });
  });

  it('falls back to the contact scan for a recipientId on a pre-#908 row', () => {
    mockUseConversations.mockReturnValue(dmsWithLegacyRowState);
    mockUseContacts.mockReturnValue(contactsWithDave);
    const renderer = renderScreen();

    act(() => {
      renderer.root
        .findAll((node) => node.props.accessibilityLabel === 'Chat with Dave')[0]
        .props.onPress();
    });

    expect(mockNavigation.push).toHaveBeenCalledWith('ChatDetail', {
      conversationId: 'dm-3',
      recipientName: 'Dave',
      recipientId: BLOCKED_PEER_ID,
    });
  });

  it('shows the search-empty state when the query matches only a hidden DM', async () => {
    mockUseConversations.mockReturnValue(dmsWithPeerIdState);
    mockBlockedSet = new Set([BLOCKED_PEER_ID]);
    const renderer = renderScreen();

    // Fuse runs over the FILTERED list, so typing the hidden peer's name can
    // never surface the row.
    await act(async () => {
      findByTestId(renderer.root, 'chats-search').props.onChangeText('Dave');
    });
    // useFuseSearch debounces 200ms on real timers.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    });

    expect(
      renderer.root.findAll(
        (n) => n.props.testID === 'search-empty-state' && typeof n.type === 'string',
      ).length,
    ).toBe(1);
    expect(hasRowNamed(renderer, 'Dave')).toBe(false);
  });
});
