/**
 * Tests for NewChatScreen — contact list, filtering, startDm, and navigation.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { NewChatScreen } from '../NewChatScreen';

jest.mock('../../services/conversationService', () => ({
  startDm: jest.fn(),
  hydrateContactsFromOrbits: jest.fn().mockResolvedValue(undefined),
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

const contactsWithBob = {
  contacts: {
    'contact-1': {
      id: 'contact-1',
      displayName: 'Bob Smith',
      username: 'bob',
      avatarPath: null,
      conversationIds: [],
    },
  },
  setContacts: jest.fn(),
  mergeContacts: jest.fn(),
  upsertContact: jest.fn(),
  removeContact: jest.fn(),
};

const emptyContactsState = {
  contacts: {},
  setContacts: jest.fn(),
  mergeContacts: jest.fn(),
  upsertContact: jest.fn(),
  removeContact: jest.fn(),
};

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


beforeEach(() => {
  jest.clearAllMocks();
  mockUseContacts.mockReturnValue(emptyContactsState);
});

describe('NewChatScreen — rendering', () => {
  it('renders the screen and search input', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'new-chat-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'new-chat-username-input')).not.toThrow();
  });

  it('shows empty message when no contacts exist', () => {
    const renderer = renderScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No contacts yet'),
    );
    expect(emptyText).toBeDefined();
  });
});

describe('NewChatScreen — contact list', () => {
  it('shows contacts from the store', () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'contact-row-contact-1')).not.toThrow();
  });

  it('filters out non-matching contacts', () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('xyz');
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No matching contacts'),
    );
    expect(emptyText).toBeDefined();
  });
});

describe('NewChatScreen — selection', () => {
  it('calls startDm when a contact is tapped', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockResolvedValue({ conversationId: 'dm-1', recipientName: 'bob' });
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'contact-row-contact-1').props.onPress();
    });

    expect(mockStartDm).toHaveBeenCalledWith('contact-1');
  });

  it('navigates to ChatDetail on success', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    mockStartDm.mockResolvedValue({ conversationId: 'dm-1', recipientName: 'bob' });
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'contact-row-contact-1').props.onPress();
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

    await act(async () => {
      findByTestId(renderer.root, 'contact-row-contact-1').props.onPress();
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
