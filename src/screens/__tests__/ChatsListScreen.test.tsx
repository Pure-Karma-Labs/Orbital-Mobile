/**
 * Tests for ChatsListScreen — DM conversation list, empty state, and navigation.
 */

import React from 'react';
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

jest.mock('../../stores', () => ({
  useConversations: (...args: unknown[]) => mockUseConversations(...args),
  useContacts: (...args: unknown[]) => mockUseContacts(...args),
}));

jest.mock('../../utils/avatarUrl', () => ({
  getAvatarUrl: jest.fn(() => null),
}));

import { loadDmConversations } from '../../services/conversationService';
const mockLoadDmConversations = loadDmConversations as jest.Mock;

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
      muteUntil: null,
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
      muteUntil: null,
      lastMessageAt: now - 1800000,
      unreadCount: 1,
      createdAt: now - 5000000,
      updatedAt: now - 1800000,
    },
  },
  conversationIds: ['dm-1', 'dm-2'],
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

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
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
