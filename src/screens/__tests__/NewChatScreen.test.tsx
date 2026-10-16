/**
 * Tests for NewChatScreen — contact list, filtering, startDm, and navigation.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { NewChatScreen } from '../NewChatScreen';
import type { Contact } from '../../types/store';

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

// The real hook reaches `useAppStore` → MMKV/nitro, which cannot load under
// Jest. Mocked at the module boundary (the ThreadsScreen idiom) so the block
// set stays a plain, test-driven value (#908).
let mockBlockedSet = new Set<string>();
jest.mock('../../hooks/useBlockedSet', () => ({
  useBlockedSet: () => mockBlockedSet,
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

/** The one contact these tests ever block (#908). */
const BLOCKED_CONTACT_ID = 'contact-2';

const blockedContact: Contact = {
  id: BLOCKED_CONTACT_ID,
  // Deliberately matches the same 'bob' filter as contact-1, so a test can
  // prove the block filter runs BEFORE the text filter.
  displayName: 'Bob Jones',
  username: 'bobjones',
  avatarPath: null,
  conversationIds: [],
};

const contactsWithBobAndBlocked = {
  ...contactsWithBob,
  contacts: {
    ...contactsWithBob.contacts,
    [BLOCKED_CONTACT_ID]: blockedContact,
  },
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

function screenElement(): React.ReactElement {
  return React.createElement(
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
 * Re-render in place. `useBlockedSet` is mocked to a plain value with no
 * subscription, so a change to `mockBlockedSet` reaches the screen on the next
 * render pass — what a real `blockedUserIds` store write would trigger.
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

/** True when a contact row is actually RENDERED (host nodes only). */
function hasContactRow(root: ReactTestInstance, contactId: string): boolean {
  return (
    root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.props.testID === `contact-row-${contactId}`,
    ).length > 0
  );
}


beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedSet = new Set<string>();
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
      // The DM-peer hint ChatDetail needs for the frame before the row carries
      // `peerUserId` (#908).
      recipientId: 'contact-1',
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

// ---------------------------------------------------------------------------
// Blocked contacts (#908)
// ---------------------------------------------------------------------------

describe('NewChatScreen — blocked contacts (#908)', () => {
  it('omits a blocked contact even when it matches the typed filter', () => {
    mockUseContacts.mockReturnValue(contactsWithBobAndBlocked);
    mockBlockedSet = new Set([BLOCKED_CONTACT_ID]);
    const renderer = renderScreen();

    expect(hasContactRow(renderer.root, BLOCKED_CONTACT_ID)).toBe(false);
    expect(hasContactRow(renderer.root, 'contact-1')).toBe(true);

    // 'bob' matches BOTH contacts' username/displayName, so a block filter
    // applied after the text filter would let this typing surface the row.
    act(() => {
      findByTestId(renderer.root, 'new-chat-username-input').props.onChangeText('bob');
    });

    expect(hasContactRow(renderer.root, BLOCKED_CONTACT_ID)).toBe(false);
    expect(hasContactRow(renderer.root, 'contact-1')).toBe(true);
  });

  it('keeps the contact when nobody is blocked', () => {
    mockUseContacts.mockReturnValue(contactsWithBobAndBlocked);
    const renderer = renderScreen();

    expect(hasContactRow(renderer.root, BLOCKED_CONTACT_ID)).toBe(true);
    expect(hasContactRow(renderer.root, 'contact-1')).toBe(true);
  });

  it('brings the contact back after an unblock', () => {
    mockUseContacts.mockReturnValue(contactsWithBobAndBlocked);
    mockBlockedSet = new Set([BLOCKED_CONTACT_ID]);
    const renderer = renderScreen();
    expect(hasContactRow(renderer.root, BLOCKED_CONTACT_ID)).toBe(false);

    mockBlockedSet = new Set<string>();
    rerenderScreen(renderer);

    expect(hasContactRow(renderer.root, BLOCKED_CONTACT_ID)).toBe(true);
  });

  it('does not call startDm for a blocked contact, even from a stale row', async () => {
    mockUseContacts.mockReturnValue(contactsWithBobAndBlocked);
    mockBlockedSet = new Set([BLOCKED_CONTACT_ID]);
    const renderer = renderScreen();

    // The list no longer renders the row, so the only way to reach
    // `handleSelect` for a blocked contact is the row a slower re-render would
    // still have on screen — rendered here straight from the list's
    // `renderItem`. That path is the guard inside `handleSelect`.
    const list = renderer.root.findAll(
      (n) => typeof n.props.renderItem === 'function',
    )[0];
    const renderItem = list.props.renderItem as (info: {
      item: Contact;
      index: number;
    }) => { props: { onPress: () => void } };
    const staleRow = renderItem({ item: blockedContact, index: 0 });

    await act(async () => {
      staleRow.props.onPress();
    });

    expect(mockStartDm).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('shows the blocked copy when startDm refuses a blocked recipient', async () => {
    mockUseContacts.mockReturnValue(contactsWithBob);
    // Shaped like `BlockedRecipientError`, matched on `name` the way the screen
    // does — `instanceof` is unavailable with the service module factory-mocked.
    const refusal = new Error('You blocked this person.');
    refusal.name = 'BlockedRecipientError';
    mockStartDm.mockRejectedValue(refusal);
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'contact-row-contact-1').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const texts = allText.map((node) => node.props.children);
    expect(texts).toContain('You blocked this person.');
    expect(texts).not.toContain('Failed to start chat. Please try again.');
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});
