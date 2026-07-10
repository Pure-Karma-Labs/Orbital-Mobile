/**
 * Tests for KeyConflictScreen — conflictSource-aware copy, recovery submission,
 * needs_email manual-entry path, result-status branch coverage.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { KeyConflictScreen } from '../KeyConflictScreen';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

const mockRecoverIdentityKeys = jest.fn();
jest.mock('../../services/keyRecoveryService', () => ({
  recoverIdentityKeys: (...args: unknown[]) => mockRecoverIdentityKeys(...args),
}));

jest.mock('../../services/authService', () => ({
  logout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

let mockConflictSource: 'push' | 'local' | null = 'local';
let mockSliceEmail: string | null = 'alice@test.com';
jest.mock('../../stores', () => ({
  useAuth: () => ({
    conflictSource: mockConflictSource,
    email: mockSliceEmail,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(KeyConflictScreen),
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

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockConflictSource = 'local';
  mockSliceEmail = 'alice@test.com';
  mockRecoverIdentityKeys.mockResolvedValue({ status: 'success' });
});

describe('KeyConflictScreen — conflictSource copy (SEC-H2)', () => {
  it('shows local copy when conflictSource is local', () => {
    mockConflictSource = 'local';
    const renderer = renderScreen();
    const desc = findByTestId(renderer.root, 'key-conflict-description');
    expect(desc.props.children).toBe('Enter your password to reset your encryption keys.');
  });

  it('shows push copy when conflictSource is push', () => {
    mockConflictSource = 'push';
    const renderer = renderScreen();
    const desc = findByTestId(renderer.root, 'key-conflict-description');
    expect(desc.props.children).toContain('reset from another device');
  });
});

describe('KeyConflictScreen — recovery submission', () => {
  it('calls recoverIdentityKeys with skipServerReset=false for local conflict', async () => {
    mockConflictSource = 'local';
    const renderer = renderScreen();

    // Press recover button to open modal
    await act(async () => {
      findByTestId(renderer.root, 'key-conflict-recover-button').props.onPress();
    });

    // Submit password via the modal
    const submitBtn = findByTestId(renderer.root, 'key-recovery-password-submit');
    const input = findByTestId(renderer.root, 'key-recovery-password-input');
    await act(async () => {
      input.props.onChangeText('my-password');
    });
    await act(async () => {
      await submitBtn.props.onPress();
    });

    expect(mockRecoverIdentityKeys).toHaveBeenCalledWith('my-password', false, undefined);
  });

  it('calls recoverIdentityKeys with skipServerReset=true for push conflict', async () => {
    mockConflictSource = 'push';
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'key-conflict-recover-button').props.onPress();
    });

    const input = findByTestId(renderer.root, 'key-recovery-password-input');
    await act(async () => {
      input.props.onChangeText('pw');
    });
    await act(async () => {
      await findByTestId(renderer.root, 'key-recovery-password-submit').props.onPress();
    });

    expect(mockRecoverIdentityKeys).toHaveBeenCalledWith('pw', true, undefined);
  });
});

describe('KeyConflictScreen — result status branches', () => {
  it('shows inline error on incorrect_password', async () => {
    mockRecoverIdentityKeys.mockResolvedValue({ status: 'incorrect_password' });
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'key-conflict-recover-button').props.onPress();
    });
    const input = findByTestId(renderer.root, 'key-recovery-password-input');
    await act(async () => { input.props.onChangeText('bad'); });
    await act(async () => {
      await findByTestId(renderer.root, 'key-recovery-password-submit').props.onPress();
    });

    const errorEl = findByTestId(renderer.root, 'key-recovery-password-error');
    expect(errorEl.props.children).toBe('Incorrect password');
  });

  it('shows rate_limited inline error', async () => {
    mockRecoverIdentityKeys.mockResolvedValue({ status: 'rate_limited' });
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'key-conflict-recover-button').props.onPress();
    });
    const input = findByTestId(renderer.root, 'key-recovery-password-input');
    await act(async () => { input.props.onChangeText('pw'); });
    await act(async () => {
      await findByTestId(renderer.root, 'key-recovery-password-submit').props.onPress();
    });

    const errorEl = findByTestId(renderer.root, 'key-recovery-password-error');
    expect(errorEl.props.children).toContain('Too many attempts');
  });
});

describe('KeyConflictScreen — needs_email manual entry (EMAIL RULING tier 3)', () => {
  it('shows editable email field when recoverIdentityKeys returns needs_email', async () => {
    mockRecoverIdentityKeys.mockResolvedValue({ status: 'needs_email', message: 'no email' });
    const renderer = renderScreen();

    // Initially no email input
    expect(findAllByTestId(renderer.root, 'key-conflict-email-input')).toHaveLength(0);

    // Trigger recovery → needs_email
    await act(async () => {
      findByTestId(renderer.root, 'key-conflict-recover-button').props.onPress();
    });
    const input = findByTestId(renderer.root, 'key-recovery-password-input');
    await act(async () => { input.props.onChangeText('pw'); });
    await act(async () => {
      await findByTestId(renderer.root, 'key-recovery-password-submit').props.onPress();
    });

    // Now email input should be visible (TextInput renders host + composite nodes)
    expect(findAllByTestId(renderer.root, 'key-conflict-email-input').length).toBeGreaterThanOrEqual(1);
  });
});
