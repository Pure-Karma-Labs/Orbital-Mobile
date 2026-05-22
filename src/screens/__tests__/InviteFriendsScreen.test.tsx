/**
 * Tests for InviteFriendsScreen — rendering, loading, and share action.
 */

import React from 'react';
import { Share } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { InviteFriendsScreen } from '../InviteFriendsScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  fetchGroupsWithInviteCodes: jest.fn(),
}));

jest.mock('../../services/crypto/contentCrypto', () => ({
  decryptGroupName: jest.fn((_enc: string, _key: Uint8Array) => 'Family Orbit'),
  getOrFetchGroupKey: jest.fn().mockResolvedValue(new Uint8Array(32)),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { fetchGroupsWithInviteCodes } from '../../services/conversationService';

const mockFetchGroups = fetchGroupsWithInviteCodes as jest.Mock;

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
  key: 'InviteFriends',
  name: 'InviteFriends' as const,
  params: undefined,
};

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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InviteFriendsScreen — rendering', () => {
  it('renders the screen with testID', async () => {
    mockFetchGroups.mockResolvedValue([]);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        React.createElement(
          SafeAreaProvider,
          { initialMetrics: safeAreaMetrics },
          React.createElement(
            ThemeProvider,
            { colorSchemeOverride: 'light' },
            React.createElement(InviteFriendsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof InviteFriendsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof InviteFriendsScreen>['route'],
            }),
          ),
        ),
      );
    });

    expect(() => findByTestId(renderer.root, 'invite-friends-screen')).not.toThrow();
  });

  it('shows empty state when no groups', async () => {
    mockFetchGroups.mockResolvedValue([]);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        React.createElement(
          SafeAreaProvider,
          { initialMetrics: safeAreaMetrics },
          React.createElement(
            ThemeProvider,
            { colorSchemeOverride: 'light' },
            React.createElement(InviteFriendsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof InviteFriendsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof InviteFriendsScreen>['route'],
            }),
          ),
        ),
      );
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No orbits'),
    );
    expect(emptyText).toBeDefined();
  });

  it('renders groups with invite codes', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        encryptedName: 'enc-name',
        wrappedGroupKey: 'enc-key',
        memberCount: 3,
        maxMembers: 10,
        isCreator: true,
        activeInviteCode: 'ABC123',
        joinedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          SafeAreaProvider,
          { initialMetrics: safeAreaMetrics },
          React.createElement(
            ThemeProvider,
            { colorSchemeOverride: 'light' },
            React.createElement(InviteFriendsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof InviteFriendsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof InviteFriendsScreen>['route'],
            }),
          ),
        ),
      );
    });

    expect(() => findByTestId(renderer.root, 'invite-group-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-code-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'share-button-g-1')).not.toThrow();

    const codeEl = findByTestId(renderer.root, 'invite-code-g-1');
    expect(codeEl.props.children).toBe('ABC123');
  });
});

describe('InviteFriendsScreen — share', () => {
  it('triggers Share.share when share button is pressed', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);

    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        encryptedName: 'enc-name',
        wrappedGroupKey: 'enc-key',
        memberCount: 3,
        maxMembers: 10,
        isCreator: true,
        activeInviteCode: 'XYZ789',
        joinedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          SafeAreaProvider,
          { initialMetrics: safeAreaMetrics },
          React.createElement(
            ThemeProvider,
            { colorSchemeOverride: 'light' },
            React.createElement(InviteFriendsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof InviteFriendsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof InviteFriendsScreen>['route'],
            }),
          ),
        ),
      );
    });

    const shareButton = findByTestId(renderer.root, 'share-button-g-1');
    await act(async () => {
      shareButton.props.onPress();
    });

    expect(shareSpy).toHaveBeenCalledWith({
      message: 'Join my orbit "Family Orbit" on Orbital! Use invite code: XYZ789',
    });

    shareSpy.mockRestore();
  });
});
