/**
 * Tests for BlockedUsersScreen — label resolution and Unblock confirmation
 * integration (#908).
 *
 * Covers:
 *  - A blocked id that resolves to a contact renders as `@handle`.
 *  - A blocked id that does not resolve renders as `user-<prefix>`.
 *  - Pressing Unblock on a row calls `confirmUnblock` with the correct user id.
 *
 * `confirmUnblock` is mocked so we verify the call contract (userId, label)
 * without the Alert machinery; `blockedUserLabel` is NOT mocked so the label
 * contract is exercised end-to-end through the screen.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Contact } from '../../../types/store';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../../stores/useAppStore', () => {
  const { create: createStore } = require('zustand');
  return {
    useAppStore: createStore(() => ({
      blockedUserIds: [] as string[],
      contacts: {} as Record<string, Contact>,
      blockedUserProfiles: {} as Record<string, string>,
    })),
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  // Prefixed `Mock` so babel allows it inside the jest.mock factory.
  const MockView = require('react-native').View;
  return { SafeAreaView: MockView };
});

jest.mock('../../../components/Header', () => ({
  Header: () => null,
}));

jest.mock('../../../components/EmojiText', () => {
  const MockText = require('react-native').Text;
  return { EmojiText: MockText };
});

const mockConfirmUnblock = jest.fn();
jest.mock('../../../utils/confirmUnblock', () => ({
  confirmUnblock: (...args: unknown[]) => mockConfirmUnblock(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { useAppStore } from '../../../stores/useAppStore';
import { ThemeProvider } from '../../../theme';
import { BlockedUsersScreen } from '../BlockedUsersScreen';

interface StoreState {
  blockedUserIds: string[];
  contacts: Record<string, Contact>;
  blockedUserProfiles: Record<string, string>;
}

const store = useAppStore as unknown as {
  setState: (partial: Partial<StoreState>) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<Contact> & { id: string }): Contact {
  return {
    username: null,
    displayName: null,
    avatarPath: null,
    conversationIds: [],
    ...overrides,
  };
}

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(BlockedUsersScreen),
      ),
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  store.setState({ blockedUserIds: [], contacts: {}, blockedUserProfiles: {} });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlockedUsersScreen', () => {
  it('shows @handle for a blocked user who resolves to a contact', () => {
    act(() => {
      store.setState({
        blockedUserIds: ['u-alice'],
        contacts: { 'u-alice': makeContact({ id: 'u-alice', username: 'alice' }) },
        blockedUserProfiles: {},
      });
    });

    const tree = render();
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('@alice');
  });

  it('shows user-<prefix> for a blocked user who does not resolve to a contact', () => {
    act(() => {
      store.setState({
        blockedUserIds: ['abcdefghijklmnop'],
        contacts: {},
        blockedUserProfiles: {},
      });
    });

    const tree = render();
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('user-abcdefgh');
    // Must not show @user-abcdefgh — unresolved ids must not carry the @ prefix.
    expect(json).not.toContain('@user-abcdefgh');
  });

  it('pressing Unblock calls confirmUnblock with the right user id and label', () => {
    act(() => {
      store.setState({
        blockedUserIds: ['u-bob'],
        contacts: { 'u-bob': makeContact({ id: 'u-bob', username: 'bob' }) },
        blockedUserProfiles: {},
      });
    });

    const tree = render();

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Unblock @bob' }).props.onPress();
    });

    expect(mockConfirmUnblock).toHaveBeenCalledTimes(1);
    expect(mockConfirmUnblock).toHaveBeenCalledWith('u-bob', '@bob');
  });
});
