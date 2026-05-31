/**
 * Tests for OrbitAdminActions — transfer ownership and dissolve orbit.
 *
 * Covers:
 * - Only renders for creator orbits (isCreator guard)
 * - Transfer confirm Alert before API call
 * - Transfer success path calls API + onCompleted
 * - Transfer 400 "no key" shows inline error, does NOT call onCompleted
 * - Transfer 403 shows inline error
 * - Transfer generic error (500 / thrown Error) shows fallback message
 * - Dissolve confirm calls API + onCompleted
 * - Dissolve cancel does nothing
 * - Members list excludes current user
 * - Empty/sole-member state renders when no error
 * - Empty state hidden when transfer error is showing
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

/**
 * Helper to extract the confirm button from an Alert.alert spy.
 * Works for both transfer ("Transfer") and dissolve ("Dissolve") alerts.
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

  it('shows confirmation Alert before calling transferOrbitOwner', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderComponent();

    // Open modal
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Select Alice — should trigger Alert, NOT the API directly
    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Transfer ownership?',
      expect.stringContaining('@alice'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Transfer', style: 'destructive' }),
      ]),
    );

    // API should NOT have been called yet (only after confirm)
    expect(mockTransfer).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('calls transferOrbitOwner and onCompleted on confirm', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    // Open modal
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Select Alice — triggers confirm Alert
    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    // Confirm the transfer via Alert
    const transferBtn = getAlertButton(alertSpy, 0, 'Transfer');
    await act(async () => {
      await transferBtn.onPress?.();
    });

    expect(mockTransfer).toHaveBeenCalledWith('g-1', 'user-2');
    expect(onCompleted).toHaveBeenCalledWith('transfer', 'g-1');

    alertSpy.mockRestore();
  });

  it('shows inline error on 400 (no key) and does NOT call onCompleted', async () => {
    mockTransfer.mockRejectedValue(
      new ValidationError(400, 'Target member has not yet received the group key'),
    );
    const alertSpy = jest.spyOn(Alert, 'alert');
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

    // Confirm the transfer via Alert
    const transferBtn = getAlertButton(alertSpy, 0, 'Transfer');
    await act(async () => {
      await transferBtn.onPress?.();
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

    alertSpy.mockRestore();
  });

  it('shows inline error on 403 and does NOT call onCompleted', async () => {
    mockTransfer.mockRejectedValue(new AuthError(403, 'Not the creator'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onCompleted = jest.fn();
    const renderer = renderComponent({ onCompleted });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-select-user-2').props.onPress();
    });

    // Confirm the transfer via Alert
    const transferBtn = getAlertButton(alertSpy, 0, 'Transfer');
    await act(async () => {
      await transferBtn.onPress?.();
    });

    expect(onCompleted).not.toHaveBeenCalled();

    const errorEl = findByTestId(renderer.root, 'transfer-error');
    const allTextNodes = errorEl.findAll(
      (node) => typeof node.children?.[0] === 'string',
    );
    const errorText = allTextNodes.map((n) => n.children[0]).join('');
    expect(errorText).toContain('Only the orbit creator');

    alertSpy.mockRestore();
  });

  it('shows generic fallback error on non-400/403 failure (e.g. 500)', async () => {
    mockTransfer.mockRejectedValue(new Error('Internal server error'));
    const alertSpy = jest.spyOn(Alert, 'alert');
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

    // Confirm via Alert
    const transferBtn = getAlertButton(alertSpy, 0, 'Transfer');
    await act(async () => {
      await transferBtn.onPress?.();
    });

    expect(onCompleted).not.toHaveBeenCalled();

    // Generic inline error should appear
    const errorEl = findByTestId(renderer.root, 'transfer-error');
    const allTextNodes = errorEl.findAll(
      (node) => typeof node.children?.[0] === 'string',
    );
    const errorText = allTextNodes.map((n) => n.children[0]).join('');
    expect(errorText).toContain('Transfer failed. Please try again.');

    alertSpy.mockRestore();
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
    // Check that the transfer error is cleared for the next open
    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });
    expect(findAllByTestId(renderer.root, 'transfer-error')).toHaveLength(0);
  });
});

describe('OrbitAdminActions — empty/sole-member state', () => {
  it('shows "No other members" when only self is in the list', async () => {
    // Only the current user — otherMembers will be empty
    const selfOnly = [members[0]];
    const renderer = renderComponent({ members: selfOnly });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    expect(() => findByTestId(renderer.root, 'transfer-empty')).not.toThrow();
    const emptyEl = findByTestId(renderer.root, 'transfer-empty');
    const allTextNodes = emptyEl.findAll(
      (node) => typeof node.children?.[0] === 'string',
    );
    const text = allTextNodes.map((n) => n.children[0]).join('');
    expect(text).toContain('No other members to transfer to.');
  });

  it('hides empty state when there is a transfer error (no dual messaging)', async () => {
    // members=undefined will trigger on-demand fetch; make it fail
    mockGetMembers.mockRejectedValue(new Error('network error'));
    const renderer = renderComponent({ members: undefined });

    await act(async () => {
      findByTestId(renderer.root, 'transfer-button-g-1').props.onPress();
    });

    // Error banner should be visible
    expect(() => findByTestId(renderer.root, 'transfer-error')).not.toThrow();
    // Empty state should NOT be visible
    expect(findAllByTestId(renderer.root, 'transfer-empty')).toHaveLength(0);
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
    const dissolveButton = getAlertButton(alertSpy, 0, 'Dissolve');

    await act(async () => {
      await dissolveButton.onPress?.();
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
    const cancelButton = getAlertButton(alertSpy, 0, 'Cancel');

    // Cancel has no onPress or it does nothing
    cancelButton.onPress?.();

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
    const dissolveBtn = getAlertButton(alertSpy, 0, 'Dissolve');

    await act(async () => {
      await dissolveBtn.onPress?.();
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
