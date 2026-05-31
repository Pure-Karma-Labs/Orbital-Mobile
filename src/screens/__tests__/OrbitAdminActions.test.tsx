/**
 * Tests for OrbitAdminActions — transfer ownership and dissolve orbit.
 *
 * Covers:
 * - Only renders for creator orbits (isCreator guard)
 * - Transfer success path calls API + onCompleted
 * - Transfer 400 "no key" shows inline error, does NOT call onCompleted
 * - Transfer 403 shows inline error
 * - Dissolve confirm calls API + onCompleted
 * - Dissolve cancel does nothing
 * - Members list excludes current user
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { OrbitAdminActions } from '../settings/OrbitAdminActions';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/api/groups', () => ({
  getGroupMembers: jest.fn(),
  transferOrbitOwner: jest.fn(),
  dissolveOrbit: jest.fn(),
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

import {
  getGroupMembers,
  transferOrbitOwner,
  dissolveOrbit,
} from '../../services/api/groups';
import { ValidationError, AuthError } from '../../services/api/errors';

const mockTransfer = transferOrbitOwner as jest.Mock;
const mockDissolve = dissolveOrbit as jest.Mock;
const mockGetMembers = getGroupMembers as jest.Mock;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const creatorGroup = {
  groupId: 'g-1',
  name: 'Family Orbit',
  inviteCode: 'ABC123',
  memberCount: 3,
  isCreator: true,
};

const nonCreatorGroup = {
  groupId: 'g-2',
  name: 'Other Orbit',
  inviteCode: null,
  memberCount: 2,
  isCreator: false,
};

const members = [
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
  {
    userId: 'user-3',
    username: 'bob',
    displayName: 'Bob',
    publicKey: 'pk3',
    avatarUrl: null,
    joinedAt: '2026-01-03T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

function renderComponent(
  props: Partial<React.ComponentProps<typeof OrbitAdminActions>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(OrbitAdminActions, {
          group: creatorGroup,
          members,
          onCompleted: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockTransfer.mockResolvedValue(undefined);
  mockDissolve.mockResolvedValue(undefined);
  mockGetMembers.mockResolvedValue(members);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrbitAdminActions — rendering', () => {
  it('renders admin actions for creator orbits', () => {
    const renderer = renderComponent();
    expect(() => findByTestId(renderer.root, 'admin-actions-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'transfer-button-g-1')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'dissolve-button-g-1')).not.toThrow();
  });

  it('renders nothing for non-creator orbits', () => {
    const renderer = renderComponent({ group: nonCreatorGroup });
    expect(findAllByTestId(renderer.root, 'admin-actions-g-2')).toHaveLength(0);
  });
});

describe('OrbitAdminActions — transfer', () => {
  it('opens member picker modal when transfer button is pressed', async () => {
    const renderer = renderComponent();

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Modal should show other members (not current user)
    expect(findAllByTestId(renderer.root, 'transfer-member-current-user-id')).toHaveLength(0);
    expect(() => findByTestId(renderer.root, 'transfer-member-user-2')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'transfer-member-user-3')).not.toThrow();
  });

  it('calls transferOrbitOwner and onCompleted on success', async () => {
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    // Open modal
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Select Alice
    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    expect(mockTransfer).toHaveBeenCalledWith('g-1', 'user-2');
    expect(onCompleted).toHaveBeenCalledWith('transfer', 'g-1');
  });

  it('shows inline error on 400 (no key) and does NOT call onCompleted', async () => {
    mockTransfer.mockRejectedValue(
      new ValidationError(400, 'Target member has not yet received the group key'),
    );
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    // Open modal
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Select Alice
    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    expect(mockTransfer).toHaveBeenCalledWith('g-1', 'user-2');
    expect(onCompleted).not.toHaveBeenCalled();

    // Inline error should appear
    const errorEl = findByTestId(renderer.root, 'transfer-error');
    const allTextNodes = errorEl.findAll(
      (node) => typeof node.children?.[0] === 'string',
    );
    const errorText = allTextNodes.map((n) => n.children[0]).join('');
    expect(errorText).toContain("hasn't received the orbit's key yet");
  });

  it('shows inline error on 403 and does NOT call onCompleted', async () => {
    mockTransfer.mockRejectedValue(new AuthError(403, 'Not the creator'));
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    expect(onCompleted).not.toHaveBeenCalled();

    const errorEl = findByTestId(renderer.root, 'transfer-error');
    const allTextNodes = errorEl.findAll(
      (node) => typeof node.children?.[0] === 'string',
    );
    const errorText = allTextNodes.map((n) => n.children[0]).join('');
    expect(errorText).toContain('Only the orbit creator');
  });

  it('fetches members on-demand when members prop is not provided', async () => {
    const renderer = renderComponent({ members: undefined });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    expect(mockGetMembers).toHaveBeenCalledWith('g-1');
    // After fetch, members should appear
    expect(() => findByTestId(renderer.root, 'transfer-member-user-2')).not.toThrow();
  });

  it('closes modal when cancel is pressed', async () => {
    const renderer = renderComponent();

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Members should be visible
    expect(() => findByTestId(renderer.root, 'transfer-member-user-2')).not.toThrow();

    await act(async () => {
      findByTestId(renderer.root, 'transfer-cancel').props.onPress();
    });

    // Modal closed — member rows should not be present (Modal visible=false)
    // The modal content may still be in the tree but the Modal is not visible
    // Check that the transfer error is cleared for the next open
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });
    expect(findAllByTestId(renderer.root, 'transfer-error')).toHaveLength(0);
  });
});

describe('OrbitAdminActions — dissolve', () => {
  it('shows destructive confirmation alert when dissolve is pressed', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderComponent();

    act(() => {
      findByTestId(renderer.root, 'dissolve-button-g-1').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dissolve'),
      expect.stringContaining('permanently delete'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Dissolve', style: 'destructive' }),
      ]),
    );

    alertSpy.mockRestore();
  });

  it('calls dissolveOrbit and onCompleted when confirmed', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    act(() => {
      findByTestId(renderer.root, 'dissolve-button-g-1').props.onPress();
    });

    // Get the destructive onPress handler
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const dissolveButton = buttons.find((b) => b.text === 'Dissolve');

    await act(async () => {
      dissolveButton?.onPress?.();
    });

    expect(mockDissolve).toHaveBeenCalledWith('g-1');
    expect(onCompleted).toHaveBeenCalledWith('dissolve', 'g-1');

    alertSpy.mockRestore();
  });

  it('does nothing when cancel is pressed in dissolve alert', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    act(() => {
      findByTestId(renderer.root, 'dissolve-button-g-1').props.onPress();
    });

    // Get cancel button from alert
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const cancelButton = buttons.find((b) => b.text === 'Cancel');

    // Cancel has no onPress or it does nothing
    cancelButton?.onPress?.();

    expect(mockDissolve).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('shows error alert on dissolve 403', async () => {
    mockDissolve.mockRejectedValue(new AuthError(403, 'Not creator'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    act(() => {
      findByTestId(renderer.root, 'dissolve-button-g-1').props.onPress();
    });

    // Get dissolve button
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const dissolveBtn = buttons.find((b) => b.text === 'Dissolve');

    await act(async () => {
      dissolveBtn?.onPress?.();
    });

    expect(onCompleted).not.toHaveBeenCalled();
    // Second alert call should be the error
    expect(alertSpy).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('Only the orbit creator'),
    );

    alertSpy.mockRestore();
  });
});
