/**
 * Tests for NewChatScreen — username input, contact lookup, startDm, and navigation.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { NewChatScreen } from '../NewChatScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  startDm: jest.fn(),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

const mockUseContacts = jest.fn();

jest.mock('../../stores', () => ({
  useContacts: (...args: unknown[]) => mockUseContacts(...args),
}));

import { startDm } from '../../services/conversationService';
const mockStartDm = startDm as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const contactsWithBob = {
  contacts: {
    'contact-1': {
      id: 'contact-1',
      displayName: 'bob',
      username: 'bob',
      avatarPath: null,
    },
  },
  setContacts: jest.fn(),
  upsertContact: jest.fn(),
  removeContact: jest.fn(),
};

const emptyContactsState = {
  contacts: {},
  setContacts: jest.fn(),
  upsertContact: jest.fn(),
  removeContact: jest.fn(),
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
  key: 'NewChat',
  name: 'NewChat' as const,
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
          React.createElement(NewChatScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof NewChatScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof NewChatScreen>['route'],
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
  mockUseContacts.mockReturnValue(emptyContactsState);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NewChatScreen — rendering', () => {
  it('renders the screen container, username input, and submit button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'new-chat-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'new-chat-username-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'new-chat-submit-btn')).not.toThrow();
  });
});

describe('NewChatScreen — validation', () => {
  it('submit button is disabled when username is empty', () => {
    const renderer = renderScreen();
    const btn = findByTestId(renderer.root, 'new-chat-submit-btn');
    expect(btn.props.disabled).toBe(true);
  });

  it('submit button is enabled when username has content', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });
    expect(findByTestId(renderer.root, 'new-chat-submit-btn').props.disabled).toBe(false);
  });
});

describe('NewChatScreen — contact lookup', () => {
  it('shows error when user is not found in contacts', async () => {
    // contacts is empty — bob not found
    mockUseContacts.mockReturnValue(emptyContactsState);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });

    await act(async () => {
      findByTestId(renderer.root, 'new-chat-submit-btn').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('not found'),
    );
    expect(errorText).toBeDefined();
    expect(mockStartDm).not.toHaveBeenCalled();
  });

  it('looks up contact case-insensitively by displayName', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockResolvedValue({ conversationId: 'dm-1', recipientName: 'bob' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('BOB');
    });

    await act(async () => {
      findByTestId(renderer.root, 'new-chat-submit-btn').props.onPress();
    });

    expect(mockStartDm).toHaveBeenCalledWith('contact-1');
  });
});

describe('NewChatScreen — submission', () => {
  it('calls startDm with contact id on successful lookup', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockResolvedValue({ conversationId: 'dm-1', recipientName: 'bob' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });

    await act(async () => {
      findByTestId(renderer.root, 'new-chat-submit-btn').props.onPress();
    });

    expect(mockStartDm).toHaveBeenCalledWith('contact-1');
  });

  it('navigates to ChatDetail via replace on success', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockResolvedValue({ conversationId: 'dm-1', recipientName: 'bob' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });

    await act(async () => {
      findByTestId(renderer.root, 'new-chat-submit-btn').props.onPress();
    });

    expect(mockNavigation.replace).toHaveBeenCalledWith('ChatDetail', {
      conversationId: 'dm-1',
      recipientName: 'bob',
    });
  });

  it('shows error on startDm failure', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockRejectedValue(new Error('Network error'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });

    await act(async () => {
      findByTestId(renderer.root, 'new-chat-submit-btn').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('failed'),
    );
    expect(errorText).toBeDefined();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});
