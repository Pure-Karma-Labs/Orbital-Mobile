/**
 * Tests for ManageOrbitsScreen — rendering, loading, invite list, code generation, and admin actions.
 */

import React from 'react';
import { Alert, Share } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ManageOrbitsScreen } from '../ManageOrbitsScreen';
import { ApiError, AuthError, NotFoundError, ValidationError } from '../../services/api/errors';
import { RATE_LIMIT_MESSAGE } from '../../utils/errorMessages';
import * as Sentry from '@sentry/react-native';

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
  wrapKeyForMember: jest.fn().mockResolvedValue(undefined),
  getPendingWrapsForGroup: jest.fn().mockResolvedValue([]),
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
  wrapKeyForMember,
  getPendingWrapsForGroup,
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
const mockWrapKeyForMember = wrapKeyForMember as jest.Mock;
const mockGetPendingWraps = getPendingWrapsForGroup as jest.Mock;
const mockCreateInviteCode = createInviteCode as jest.Mock;
const mockTransfer = transferOrbitOwner as jest.Mock;
const mockDissolve = dissolveOrbit as jest.Mock;
const mockCaptureException = Sentry.captureException as unknown as jest.Mock;

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

// ---------------------------------------------------------------------------
// Rewrap key tests
// ---------------------------------------------------------------------------

describe('ManageOrbitsScreen — rewrap key', () => {
  const testGroup = {
    groupId: 'g-1',
    name: 'Family Orbit',
    memberCount: 3,
    isCreator: true,
  };

  const pendingWrapsResponse = [
    { userId: 'user-2', identityPublicKey: 'aWRlbnRpdHlLZXkyBase64==' },
  ];

  async function renderAndExpand() {
    const element = React.createElement(
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
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(element);
    });
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });
    return renderer;
  }

  it('renders rewrap button only for pending members (not self, not non-pending)', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);

    const renderer = await renderAndExpand();

    // user-2 is pending — rewrap button should exist
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2').filter(
      (n) => typeof n.type === 'string',
    ).length).toBeGreaterThanOrEqual(1);

    // current-user-id is not pending and is self — no rewrap button
    expect(findAllByTestId(renderer.root, 'rewrap-member-current-user-id')).toHaveLength(0);
  });

  it('does not render rewrap button for non-pending members', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue([
      ...testMembers,
      {
        userId: 'user-3',
        username: 'bob',
        displayName: 'Bob',
        publicKey: 'pk3',
        avatarUrl: null,
        joinedAt: '2026-01-03T00:00:00Z',
      },
    ]);
    // Only user-2 is pending, not user-3
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);

    const renderer = await renderAndExpand();

    // user-3 not pending — no rewrap button
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-3')).toHaveLength(0);
    // user-2 is pending — rewrap button present
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2').filter(
      (n) => typeof n.type === 'string',
    ).length).toBeGreaterThanOrEqual(1);
  });

  it('shows busy label while rewrapping', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);

    // Make wrapKeyForMember hang so we can observe busy state
    let resolveWrap!: () => void;
    mockWrapKeyForMember.mockImplementation(
      () => new Promise<void>((resolve) => { resolveWrap = resolve; }),
    );

    const renderer = await renderAndExpand();

    // Press rewrap — should enter busy state
    await act(async () => {
      findByTestId(renderer.root, 'rewrap-member-user-2').props.onPress();
    });

    // Find the text within the rewrap button — should show busy label
    const rewrapBtn = findByTestId(renderer.root, 'rewrap-member-user-2');
    const textNodes = rewrapBtn.findAllByType('Text' as unknown as React.ComponentType);
    const busyLabel = textNodes.find(
      (t) => typeof t.props.children === 'string' && t.props.children.includes('Rewrapping'),
    );
    expect(busyLabel).toBeDefined();

    // Resolve to clean up
    await act(async () => {
      resolveWrap();
    });
  });

  it('removes rewrap button on success', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);
    mockWrapKeyForMember.mockResolvedValue(undefined);

    const renderer = await renderAndExpand();

    // Rewrap button should be present before action
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2').filter(
      (n) => typeof n.type === 'string',
    ).length).toBeGreaterThanOrEqual(1);

    // Press rewrap
    await act(async () => {
      findByTestId(renderer.root, 'rewrap-member-user-2').props.onPress();
    });

    // After success, rewrap button should be gone
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2')).toHaveLength(0);

    expect(mockWrapKeyForMember).toHaveBeenCalledWith('g-1', {
      userId: 'user-2',
      identityPublicKey: 'aWRlbnRpdHlLZXkyBase64==',
    });
  });

  it('treats 409 ALREADY_WRAPPED as resolved (removes button)', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);

    const conflictError = new Error('ALREADY_WRAPPED');
    mockWrapKeyForMember.mockRejectedValue(conflictError);

    const renderer = await renderAndExpand();

    await act(async () => {
      findByTestId(renderer.root, 'rewrap-member-user-2').props.onPress();
    });

    // 409 treated as resolved — button should be gone
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2')).toHaveLength(0);
  });

  it('keeps button and alerts on non-409 failure', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');

    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    mockGetPendingWraps.mockResolvedValue(pendingWrapsResponse);

    const networkError = new Error('Network request failed');
    mockWrapKeyForMember.mockRejectedValue(networkError);

    const renderer = await renderAndExpand();

    await act(async () => {
      findByTestId(renderer.root, 'rewrap-member-user-2').props.onPress();
    });

    // Button should still be present
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2').filter(
      (n) => typeof n.type === 'string',
    ).length).toBeGreaterThanOrEqual(1);

    // Alert should have been called with the error message
    expect(alertSpy).toHaveBeenCalledWith(
      'Rewrap Failed',
      'Network request failed',
    );

    alertSpy.mockRestore();
  });

  it('hides all rewrap buttons when pending-wraps fetch fails', async () => {
    mockFetchGroups.mockResolvedValue([testGroup]);
    mockGetMembers.mockResolvedValue(testMembers);
    // Simulate 403 / non-key-holder
    mockGetPendingWraps.mockRejectedValue(new Error('403 Forbidden'));

    const renderer = await renderAndExpand();

    // No rewrap buttons should exist for any user
    expect(findAllByTestId(renderer.root, 'rewrap-member-user-2')).toHaveLength(0);
    expect(findAllByTestId(renderer.root, 'rewrap-member-current-user-id')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers for invite email routing tests
//
// Duplicated from JoinOrbitScreen.test.tsx — extraction to
// src/screens/__tests__/helpers.ts is tracked in Mobile #872.
// ---------------------------------------------------------------------------

/**
 * Host-node filter, NOT `findByTestId`: `ErrorBanner` carries the testID on its
 * own component node even on the render where it returns `null`, so the
 * unfiltered helper would make every presence/absence check vacuous.
 */
function hasGenerateCodeErrorBanner(root: ReactTestInstance): boolean {
  return (
    root.findAll(
      (n) => typeof n.type === 'string' && n.props.testID === 'generate-code-error-banner',
    ).length > 0
  );
}

/**
 * A real `ValidationError` built from a backend-shaped VALIDATION_ERROR body,
 * so the `details.code` → copy mapping under test is the production parse and
 * not a hand-set field.
 */
function reasonedValidationError(code: string, message = 'server text'): ValidationError {
  return new ValidationError(
    400,
    JSON.stringify({ error: 'VALIDATION_ERROR', message, details: { code } }),
  );
}

/**
 * Host-node finder for asserting keyboard props.
 * Asserting on the component node would be near-vacuous (same prop names).
 */
function findHostByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll(
    (n) => typeof n.type === 'string' && n.props.testID === testID,
  );
  if (found.length === 0) throw new Error(`No HOST element with testID "${testID}"`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Copy literals (written out as consts — not imported from source to avoid
// coupling test failure modes to source refactors of unrelated copy).
// ---------------------------------------------------------------------------
const INVITE_INVALID_EMAIL_MESSAGE = 'Please enter a valid email address';
const INVITE_NOT_ALLOWED_COPY = "You can't create invites for this orbit";
const INVITE_ORBIT_GONE_COPY = 'This orbit no longer exists';
const INVITE_GENERIC_FAILURE_COPY = 'Failed to generate invite code. Please try again.';

/** True when some rendered Text has exactly these children. */
function hasText(root: ReactTestInstance, children: string): boolean {
  return root
    .findAllByType('Text' as unknown as React.ComponentType)
    .some((n) => n.props.children === children);
}

describe('ManageOrbitsScreen — invite email routing', () => {
  /**
   * Helper: render the screen, expand the orbit, and open the email modal.
   */
  async function renderAndOpenModal(): Promise<ReactTestRenderer> {
    mockFetchGroups.mockResolvedValue([
      { groupId: 'g-1', name: 'Family Orbit', memberCount: 3, isCreator: true },
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
    await act(async () => {
      findByTestId(renderer.root, 'orbit-header-g-1').props.onPress();
    });
    await act(async () => {
      findByTestId(renderer.root, 'new-code-button-g-1').props.onPress();
    });
    return renderer;
  }

  it('case 1: pre-flight rejects a malformed address without calling createInviteCode', async () => {
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('a@b');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    const errorNode = findHostByTestId(renderer.root, 'email-input-error');
    expect(errorNode.props.children).toBe(INVITE_INVALID_EMAIL_MESSAGE);
    expect(mockCreateInviteCode).not.toHaveBeenCalled();
    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 2: coded EMAIL_FORMAT from server → field error, no banner, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(reasonedValidationError('EMAIL_FORMAT'));
    const renderer = await renderAndOpenModal();

    // A well-formed address bypasses the pre-flight so the request is genuinely issued
    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(mockCreateInviteCode).toHaveBeenCalled();
    const errorNode = findHostByTestId(renderer.root, 'email-input-error');
    expect(errorNode.props.children).toBe(INVITE_INVALID_EMAIL_MESSAGE);
    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 3: uncoded 400 → generic banner, no field error, one capture, no Alert', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const thrown = new ValidationError(400, 'some server text');
    mockCreateInviteCode.mockRejectedValue(thrown);
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(true);
    // The banner's words, not just its presence: the legacy retry copy, and
    // never the raw server text (which rides only in __DEV__ serverMessage).
    expect(hasText(renderer.root, INVITE_GENERIC_FAILURE_COPY)).toBe(true);
    expect(hasText(renderer.root, 'some server text')).toBe(false);
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);
    // Alert must NOT be called — the old Alert.alert on failure is gone
    expect(alertSpy).not.toHaveBeenCalled();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = mockCaptureException.mock.calls[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError).not.toBe(thrown);
    expect(context).toEqual({
      tags: { feature: 'orbit-invite-create', status: '400', api_code: 'VALIDATION_ERROR' },
    });

    alertSpy.mockRestore();
  });

  it('case 4: coded but unrouted reason → generic banner, no field error, capture with validation_reason_routed:false', async () => {
    const thrown = reasonedValidationError('GROUP_FULL');
    mockCreateInviteCode.mockRejectedValue(thrown);
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(true);
    // The screen renders its own legacy copy, NOT the GROUP_FULL copy that
    // errors.ts selected for the reason — this screen does not route it.
    expect(hasText(renderer.root, INVITE_GENERIC_FAILURE_COPY)).toBe(true);
    expect(
      hasText(renderer.root, 'This orbit is full — ask the orbit admin to make room'),
    ).toBe(false);
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = mockCaptureException.mock.calls[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError).not.toBe(thrown);
    expect(context).toEqual({
      tags: {
        feature: 'orbit-invite-create',
        validation_reason_routed: 'false',
        status: '400',
        api_code: 'VALIDATION_ERROR',
      },
    });
  });

  it('case RATE_LIMITED: rate limit error → banner with RATE_LIMIT_MESSAGE, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(
      new ApiError('Too many requests', 429, 'RATE_LIMITED', false),
    );
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(true);
    expect(
      renderer.root
        .findAllByType('Text' as unknown as React.ComponentType)
        .some((n) => n.props.children === RATE_LIMIT_MESSAGE),
    ).toBe(true);
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 404: orbit gone → not-found banner, no field error, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(new NotFoundError());
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(true);
    expect(
      renderer.root
        .findAllByType('Text' as unknown as React.ComponentType)
        .some((n) => n.props.children === INVITE_ORBIT_GONE_COPY),
    ).toBe(true);
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 7: host input node carries correct keyboard props', async () => {
    const renderer = await renderAndOpenModal();

    const hostInput = findHostByTestId(renderer.root, 'email-input');
    expect(hostInput.props.keyboardType).toBe('email-address');
    expect(hostInput.props.autoCapitalize).toBe('none');
    expect(hostInput.props.autoCorrect).toBe(false);
    expect(hostInput.props.maxLength).toBe(256);
    expect(hostInput.props.textContentType).toBeUndefined();
  });

  it('case 6: retyping the email after a field error clears the field error node', async () => {
    const renderer = await renderAndOpenModal();

    // Trigger pre-flight field error
    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('a@b');
    });
    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ).length,
    ).toBeGreaterThan(0);

    // User retypes — error should clear
    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);
  });

  it('case 5: 403 AuthError → not-allowed banner, no field error, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(new AuthError(403, 'not creator'));
    const renderer = await renderAndOpenModal();

    act(() => {
      findByTestId(renderer.root, 'email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-button').props.onPress();
    });

    expect(hasGenerateCodeErrorBanner(renderer.root)).toBe(true);
    expect(
      renderer.root
        .findAllByType('Text' as unknown as React.ComponentType)
        .some((n) => n.props.children === INVITE_NOT_ALLOWED_COPY),
    ).toBe(true);
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'email-input-error',
      ),
    ).toHaveLength(0);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
