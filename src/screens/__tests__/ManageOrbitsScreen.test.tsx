/**
 * Tests for ManageOrbitsScreen — rendering, loading, filtering, and share action.
 */

import React from 'react';
import { Share } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ManageOrbitsScreen } from '../ManageOrbitsScreen';

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

jest.mock('../../services/api/groups', () => ({
  getGroupMembers: jest.fn().mockResolvedValue([]),
  generateInviteCode: jest.fn().mockResolvedValue({
    inviteCode: 'NEW123',
    expiresAt: '2026-06-01T00:00:00Z',
    createdAt: '2026-05-24T00:00:00Z',
    targetEmail: 'test@example.com',
  }),
  removeMember: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

jest.mock('../../stores', () => ({
  useAuth: jest.fn(() => ({
    isAuthenticated: true,
    userId: 'current-user-id',
    username: 'testuser',
    displayName: 'Test User',
    avatarPath: null,
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),
    updateProfile: jest.fn(),
  })),
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
  key: 'ManageOrbits',
  name: 'ManageOrbits' as const,
  params: undefined,
};

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
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

describe('ManageOrbitsScreen — rendering', () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    expect(() => findByTestId(renderer.root, 'manage-orbits-screen')).not.toThrow();
  });

  it('shows empty state when no creator groups', async () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const emptyText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes("don't manage any orbits"),
    );
    expect(emptyText).toBeDefined();
  });

  it('renders creator groups with invite codes', async () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    expect(() => findByTestId(renderer.root, 'orbit-row-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'orbit-header-g-1')).not.toThrow();
  });

  it('does NOT render non-creator groups', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-creator',
        encryptedName: 'enc-name',
        wrappedGroupKey: 'enc-key',
        memberCount: 3,
        maxMembers: 10,
        isCreator: true,
        activeInviteCode: 'ABC123',
        joinedAt: '2026-05-01T00:00:00Z',
      },
      {
        groupId: 'g-member-only',
        encryptedName: 'enc-name-2',
        wrappedGroupKey: 'enc-key-2',
        memberCount: 5,
        maxMembers: 10,
        isCreator: false,
        activeInviteCode: 'DEF456',
        joinedAt: '2026-05-02T00:00:00Z',
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    // Creator group should be rendered
    expect(() => findByTestId(renderer.root, 'orbit-row-g-creator')).not.toThrow();
    // Non-creator group should NOT be rendered
    expect(findAllByTestId(renderer.root, 'orbit-row-g-member-only')).toHaveLength(0);
  });
});

describe('ManageOrbitsScreen — interactions', () => {
  it('navigates back when the Header back button is pressed', async () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    const backButton = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Go back',
    );
    expect(backButton.length).toBeGreaterThan(0);
    await act(async () => {
      backButton[0].props.onPress();
    });
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });

  it('opens email modal when new-code button is pressed', async () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    // Expand the orbit row
    const header = findByTestId(renderer.root, 'orbit-header-g-1');
    await act(async () => {
      header.props.onPress();
    });

    // Press the new-code button to open the email modal
    const newCodeBtn = findByTestId(renderer.root, 'new-code-button-g-1');
    await act(async () => {
      newCodeBtn.props.onPress();
    });

    // The email modal should now be visible
    expect(() => findByTestId(renderer.root, 'email-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'generate-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'cancel-button')).not.toThrow();
  });

  it('generates an invite code via the email modal', async () => {
    const { generateInviteCode: mockGenerate } = require('../../services/api/groups');

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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    // Expand → open modal → fill email → generate
    const header = findByTestId(renderer.root, 'orbit-header-g-1');
    await act(async () => { header.props.onPress(); });

    const newCodeBtn = findByTestId(renderer.root, 'new-code-button-g-1');
    await act(async () => { newCodeBtn.props.onPress(); });

    const emailInput = findByTestId(renderer.root, 'email-input');
    await act(async () => {
      emailInput.props.onChangeText('family@example.com');
    });

    const generateBtn = findByTestId(renderer.root, 'generate-button');
    await act(async () => { generateBtn.props.onPress(); });

    expect(mockGenerate).toHaveBeenCalledWith('g-1', 'family@example.com');
  });
});

describe('ManageOrbitsScreen — share', () => {
  it('triggers Share.share when share button is pressed after expand', async () => {
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
            React.createElement(ManageOrbitsScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['navigation'],
              route: mockRoute as unknown as React.ComponentProps<typeof ManageOrbitsScreen>['route'],
            }),
          ),
        ),
      );
    });

    // Expand the orbit row
    const header = findByTestId(renderer.root, 'orbit-header-g-1');
    await act(async () => {
      header.props.onPress();
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
