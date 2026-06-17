/**
 * Tests for ManageOrbitsScreen — rendering, loading, invite list, code generation, and admin actions.
 */

import React from 'react';
import { Alert, Share } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ManageOrbitsScreen } from '../ManageOrbitsScreen';

// ---------------------------------------------------------------------------
// Stable mock references (hoisted for assertion)
// ---------------------------------------------------------------------------

const mockRemoveConversation = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  fetchCreatorOrbitsDecrypted: jest.fn(),
  loadConversations: jest.fn().mockResolvedValue(undefined),
  createInviteCode: jest.fn(),
}));

jest.mock('../../services/api/groups', () => ({
  getGroupMembers: jest.fn().mockResolvedValue([]),
  listInviteHistory: jest.fn().mockResolvedValue([]),
  removeMember: jest.fn().mockResolvedValue(undefined),
  transferOrbitOwner: jest.fn().mockResolvedValue(undefined),
  dissolveOrbit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
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
  useConversations: jest.fn(() => ({
    conversations: {},
    conversationIds: [],
    activeConversationId: null,
    setConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: mockRemoveConversation,
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
  })),
}));

import {
  fetchCreatorOrbitsDecrypted,
  loadConversations,
  createInviteCode,
} from '../../services/conversationService';
import {
  getGroupMembers,
  listInviteHistory,
  transferOrbitOwner,
  dissolveOrbit,
} from '../../services/api/groups';

const mockFetchGroups = fetchCreatorOrbitsDecrypted as jest.Mock;
const mockLoadConversations = loadConversations as jest.Mock;
const mockGetMembers = getGroupMembers as jest.Mock;
const mockListInvites = listInviteHistory as jest.Mock;
const mockCreateInviteCode = createInviteCode as jest.Mock;
const mockTransfer = transferOrbitOwner as jest.Mock;
const mockDissolve = dissolveOrbit as jest.Mock;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const testMembers = [
  {
    userId: 'current-user-id',
    username: 'testuser',
    displayName: 'Test User',
    publicKey: 'pk1',
    avatarUrl: null,
    joinedAt: '2026-01-01T00:00:00Z',
  },
  {
    userId: 'user-2',
    username: 'alice',
    displayName: 'Alice',
    publicKey: 'pk2',
    avatarUrl: null,
    joinedAt: '2026-01-02T00:00:00Z',
  },
];

const testInvites = [
  {
    id: 'inv-1',
    codeVersion: 2,
    createdAt: 1717200000000,
    expiresAt: 1717804800000,
    status: 'pending' as const,
    targetEmail: 'alice@example.com',
  },
  {
    id: 'inv-2',
    codeVersion: 2,
    createdAt: 1717100000000,
    expiresAt: 1717704800000,
    status: 'accepted' as const,
    targetEmail: 'bob@example.com',
  },
  {
    id: 'inv-3',
    codeVersion: 1,
    createdAt: 1717000000000,
    expiresAt: 1717604800000,
    status: 'expired' as const,
    targetEmail: 'charlie@example.com',
  },
];

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

/**
 * Helper to extract a button from an Alert.alert spy.
 */
function getAlertButton(
  alertSpy: jest.SpyInstance,
  callIndex: number,
  buttonText: string,
): { text: string; onPress?: () => void | Promise<void> } {
  const alertArgs = alertSpy.mock.calls[callIndex];
  const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void | Promise<void> }>;
  const btn = buttons.find((b) => b.text === buttonText);
  if (!btn) throw new Error(`No button "${buttonText}" in Alert call #${callIndex}`);
  return btn;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadConversations.mockResolvedValue(undefined);
  mockTransfer.mockResolvedValue(undefined);
  mockDissolve.mockResolvedValue(undefined);
  mockListInvites.mockResolvedValue([]);
  mockCreateInviteCode.mockResolvedValue('ABCD1234EFGH5678JKMN');
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

  it('renders creator groups', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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

  it('loads invite history when orbit is expanded', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
      },
    ]);
    mockListInvites.mockResolvedValue(testInvites);

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
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    expect(mockListInvites).toHaveBeenCalledWith('g-1');

    // Invite rows should be visible
    expect(() => findByTestId(renderer.root, 'invite-inv-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-inv-2')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-inv-3')).not.toThrow();
  });

  it('shows status badges for pending/accepted/expired', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
      },
    ]);
    mockListInvites.mockResolvedValue(testInvites);

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

    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    // Find status badge elements
    const pendingBadge = findByTestId(renderer.root, 'invite-status-inv-1');
    const acceptedBadge = findByTestId(renderer.root, 'invite-status-inv-2');
    const expiredBadge = findByTestId(renderer.root, 'invite-status-inv-3');

    // Verify status text in badge children
    const pendingText = pendingBadge.findAllByType('Text' as unknown as React.ComponentType);
    expect(pendingText.some((t) => t.props.children === 'pending')).toBe(true);

    const acceptedText = acceptedBadge.findAllByType('Text' as unknown as React.ComponentType);
    expect(acceptedText.some((t) => t.props.children === 'accepted')).toBe(true);

    const expiredText = expiredBadge.findAllByType('Text' as unknown as React.ComponentType);
    expect(expiredText.some((t) => t.props.children === 'expired')).toBe(true);
  });

  it('opens email modal when new-code button is pressed', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    // Press the new-code button to open the email modal
    await act(async () => {
      findByTestId(renderer.root, 'new-code-button-g-1').props.onPress();
    });

    // Phase 1 of modal: email input should be visible
    expect(() => findByTestId(renderer.root, 'email-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'generate-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'cancel-button')).not.toThrow();
  });

  it('generates a v2 invite code via the email modal and transitions to Phase 2', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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

    // Expand -> open modal -> fill email -> generate
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'new-code-button-g-1').props.onPress();
    });

    const emailInput = findByTestId(renderer.root, 'email-input');
    await act(async () => {
      emailInput.props.onChangeText('family@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(mockCreateInviteCode).toHaveBeenCalledWith('g-1', 'family@example.com');

    // Phase 2: formatted code should be visible in the modal
    expect(() => findByTestId(renderer.root, 'modal-invite-code')).not.toThrow();
    const codeEl = findByTestId(renderer.root, 'modal-invite-code');
    expect(codeEl.props.children).toBe('ABCD-1234-EFGH-5678-JKMN');

    // Warning and buttons visible
    expect(() => findByTestId(renderer.root, 'modal-code-warning')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'modal-share-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'modal-done-button')).not.toThrow();
  });

  it('generatedCode is nulled on modal dismiss', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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

    // Expand -> open modal -> generate code -> dismiss
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'new-code-button-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('test@test.com');
    });
    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    // Phase 2 should be visible
    expect(() => findByTestId(renderer.root, 'modal-invite-code')).not.toThrow();

    // Dismiss via Done button
    await act(async () => {
      findByTestId(renderer.root, 'modal-done-button').props.onPress();
    });

    // Modal should be closed — no more modal-invite-code
    expect(findAllByTestId(renderer.root, 'modal-invite-code')).toHaveLength(0);
  });

  it('shares formatted code from modal Phase 2', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);

    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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

    // Expand -> open modal -> generate -> share
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'new-code-button-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('family@example.com');
    });
    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'modal-share-button').props.onPress();
    });

    expect(shareSpy).toHaveBeenCalledWith({
      message: 'Join my orbit "Family Orbit" on Orbital! Use invite code: ABCD-1234-EFGH-5678-JKMN',
    });

    shareSpy.mockRestore();
  });
});

describe('ManageOrbitsScreen — admin actions', () => {
  it('renders admin actions when orbit row is expanded', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
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
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    // Admin actions should be visible
    expect(() => findByTestId(renderer.root, 'admin-actions-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'transfer-button-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'dissolve-button-g-1')).not.toThrow();
  });

  it('transfer triggers a re-fetch of creator orbits and refreshes conversations', async () => {
    // Provide members so OrbitAdminActions can show the picker
    mockGetMembers.mockResolvedValue(testMembers);
    mockFetchGroups
      .mockResolvedValueOnce([
        {
          groupId: 'g-1',
          name: 'Family Orbit',
          memberCount: 3,
          isCreator: true,
          },
      ])
      // Second call (after transfer) returns empty — orbit is no longer ours
      .mockResolvedValueOnce([]);

    const alertSpy = jest.spyOn(Alert, 'alert');

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

    // Expand to load members
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    // Open transfer modal
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Select alice — triggers confirmation Alert
    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    // Confirm the transfer via Alert
    const transferBtn = getAlertButton(alertSpy, 0, 'Transfer');
    await act(async () => {
      await transferBtn.onPress?.();
    });

    expect(mockTransfer).toHaveBeenCalledWith('g-1', 'user-2');
    // fetchCreatorOrbitsDecrypted should have been called twice (initial + refresh)
    expect(mockFetchGroups).toHaveBeenCalledTimes(2);
    // loadConversations called to refresh inbox
    expect(mockLoadConversations).toHaveBeenCalled();
    // Orbit should be gone from the list after re-fetch
    expect(findAllByTestId(renderer.root, 'orbit-row-g-1')).toHaveLength(0);

    alertSpy.mockRestore();
  });

  it('dissolve calls removeConversation and removes orbit from list', async () => {
    mockFetchGroups.mockResolvedValue([
      {
        groupId: 'g-1',
        name: 'Family Orbit',
        memberCount: 3,
        isCreator: true,
      },
    ]);

    const alertSpy = jest.spyOn(Alert, 'alert');

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
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });

    // Press dissolve — triggers OrbitAdminActions dissolve which shows Alert
    await act(async () => {
      findByTestId(renderer.root, 'dissolve-button-g-1').props.onPress();
    });

    // Confirm the dissolve via Alert
    const dissolveBtn = getAlertButton(alertSpy, 0, 'Dissolve');
    await act(async () => {
      await dissolveBtn.onPress?.();
    });

    expect(mockDissolve).toHaveBeenCalledWith('g-1');
    // removeConversation should be called with the groupId
    expect(mockRemoveConversation).toHaveBeenCalledWith('g-1');
    // loadConversations called to refresh inbox
    expect(mockLoadConversations).toHaveBeenCalled();
    // Orbit should be removed from the list
    expect(findAllByTestId(renderer.root, 'orbit-row-g-1')).toHaveLength(0);

    alertSpy.mockRestore();
  });
});
