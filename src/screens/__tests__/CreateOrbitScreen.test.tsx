/**
 * Tests for CreateOrbitScreen — create orbit form, two-phase success view, and error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { CreateOrbitScreen } from '../CreateOrbitScreen';
import { ApiError, AuthError, NetworkError, ValidationError } from '../../services/api/errors';
import { RATE_LIMIT_MESSAGE } from '../../utils/errorMessages';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// @sentry/react-native: rely on the ROOT __mocks__/@sentry/react-native.ts
// manual mock (Jest auto-applies it). The per-suite factory that was here is
// deliberately removed so all suites share the same mock instance and the
// existing Sentry assertions below can use the same `mockCaptureException`
// handle as the new email-routing describe block.

jest.mock('../../services/conversationService', () => ({
  createOrbit: jest.fn(),
  createInviteCode: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { createOrbit, createInviteCode } from '../../services/conversationService';
import * as Sentry from '@sentry/react-native';
const mockCreateOrbit = createOrbit as jest.Mock;
const mockCreateInviteCode = createInviteCode as jest.Mock;
const mockCaptureException = Sentry.captureException as unknown as jest.Mock;

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
  key: 'CreateOrbit',
  name: 'CreateOrbit' as const,
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
          React.createElement(CreateOrbitScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof CreateOrbitScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof CreateOrbitScreen>['route'],
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

function findTextWithChildren(
  root: ReactTestInstance,
  children: string,
): ReactTestInstance | undefined {
  return root
    .findAllByType('Text' as unknown as React.ComponentType)
    .find((node) => node.props.children === children);
}

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
function hasErrorBanner(root: ReactTestInstance): boolean {
  return (
    root.findAll(
      (n) => typeof n.type === 'string' && n.props.testID === 'invite-error-banner',
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateOrbitScreen — rendering', () => {
  it('renders the form with orbit name input and create button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'create-orbit-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'orbit-name-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'create-orbit-button')).not.toThrow();
  });
});

describe('CreateOrbitScreen — validation', () => {
  it('create button is disabled when name is empty', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('create button is disabled when name is only whitespace', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');
    act(() => {
      input.props.onChangeText('   ');
    });
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('create button is enabled when name has non-whitespace content', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');
    act(() => {
      input.props.onChangeText('Family Orbit');
    });
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(false);
  });
});

describe('CreateOrbitScreen — submission', () => {
  it('calls createOrbit with trimmed name on submit', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');

    act(() => {
      input.props.onChangeText('  Family Orbit  ');
    });

    const button = findByTestId(renderer.root, 'create-orbit-button');
    await act(async () => {
      button.props.onPress();
    });

    expect(mockCreateOrbit).toHaveBeenCalledWith('Family Orbit');
  });

  it('shows Phase 1 success view with email input after creation', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-email-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'generate-invite-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'skip-button')).not.toThrow();
  });

  it('skip button calls navigation.goBack()', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'skip-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('CreateOrbitScreen — invite generation', () => {
  it('generates v2 invite code and shows formatted code', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    mockCreateInviteCode.mockResolvedValue('ABCD1234EFGH5678JKMN');

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    // Phase 1 — enter email
    const emailInput = findByTestId(renderer.root, 'invite-email-input');
    act(() => {
      emailInput.props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(mockCreateInviteCode).toHaveBeenCalledWith('g-1', 'member@example.com');

    // Phase 2 — formatted code shown
    const codeText = findByTestId(renderer.root, 'invite-code-text');
    expect(codeText.props.children).toBe('ABCD-1234-EFGH-5678-JKMN');

    // Warning text visible
    expect(() => findByTestId(renderer.root, 'code-warning')).not.toThrow();

    // Share and Done buttons visible
    expect(() => findByTestId(renderer.root, 'share-invite-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'done-button')).not.toThrow();
  });

  it('done button calls navigation.goBack() from Phase 2', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    mockCreateInviteCode.mockResolvedValue('ABCD1234EFGH5678JKMN');

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('test@test.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'done-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('shows the NetworkError message on the invite banner when createInviteCode fails', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const netErr = new NetworkError('No connection');
    mockCreateInviteCode.mockRejectedValue(netErr);

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, netErr.message)).toBeDefined();
  });

  it('shows RATE_LIMIT_MESSAGE on the invite banner for a RATE_LIMITED ApiError from createInviteCode', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    mockCreateInviteCode.mockRejectedValue(
      new ApiError('Too many requests', 429, 'RATE_LIMITED', false),
    );

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, RATE_LIMIT_MESSAGE)).toBeDefined();
  });

  it('shows the generic invite-failure copy for an unrecognized error, and never the raw server message', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    mockCreateInviteCode.mockRejectedValue(new Error('boom'));

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(
      findTextWithChildren(renderer.root, 'Failed to generate invite code. Please try again.'),
    ).toBeDefined();
    expect(findTextWithChildren(renderer.root, 'boom')).toBeUndefined();
  });
});

describe('CreateOrbitScreen — error handling', () => {
  it('shows a generic banner on creation failure, never the field error node, never the raw server message, and reports to Sentry', async () => {
    const thrown = new Error('Server error');
    mockCreateOrbit.mockRejectedValue(thrown);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, 'Could not create orbit — please try again')).toBeDefined();
    expect(() => findByTestId(renderer.root, 'orbit-name-input-error')).toThrow();
    expect(findTextWithChildren(renderer.root, 'Server error')).toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = mockCaptureException.mock.calls[0];
    // #746: the screen reports through `captureError`, which sends a REBUILT
    // Error — class name plus scrubbed message, nothing the thrower hung off
    // the object. So this is deliberately NOT the instance we rejected with.
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError).not.toBe(thrown);
    expect((reportedError as Error).name).toBe('Error');
    expect((reportedError as Error).message).toBe('Server error');
    // Exact match, not objectContaining: `captureError` omits `level`/`extra`
    // when the call site passed neither, and a non-ApiError adds no
    // status/api_code tags (#746).
    expect(context).toEqual({ tags: { feature: 'orbit-create' } });
  });

  it('shows the NetworkError message on the banner, without reporting to Sentry', async () => {
    const netErr = new NetworkError('No connection');
    mockCreateOrbit.mockRejectedValue(netErr);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, netErr.message)).toBeDefined();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('shows RATE_LIMIT_MESSAGE on the banner for a RATE_LIMITED ApiError, without reporting to Sentry', async () => {
    mockCreateOrbit.mockRejectedValue(
      new ApiError('Too many requests', 429, 'RATE_LIMITED', false),
    );
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, RATE_LIMIT_MESSAGE)).toBeDefined();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('clears the banner when the orbit name is edited after a failure', async () => {
    mockCreateOrbit.mockRejectedValue(new Error('Server error'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, 'Could not create orbit — please try again')).toBeDefined();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit 2');
    });

    expect(findTextWithChildren(renderer.root, 'Could not create orbit — please try again')).toBeUndefined();
  });
});

describe('CreateOrbitScreen — loading state', () => {
  it('calls createOrbit once and shows success view after resolution', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(mockCreateOrbit).toHaveBeenCalledTimes(1);
    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Copy literals (written out as consts — not imported from source to avoid
// coupling test failure modes to source refactors of unrelated copy).
// ---------------------------------------------------------------------------
const INVALID_EMAIL_MESSAGE = 'Please enter a valid email address';
const NOT_ALLOWED_COPY = "You can't create invites for this orbit";
const GENERIC_INVITE_FAILURE_COPY = 'Failed to generate invite code. Please try again.';

describe('CreateOrbitScreen — invite email routing', () => {
  /**
   * Helper: reach Phase 1 (invite form) from a fresh render.
   */
  async function renderAndReachInviteForm(): Promise<ReactTestRenderer> {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1' });
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });
    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });
    return renderer;
  }

  it('case 1: pre-flight rejects a malformed address without calling createInviteCode', async () => {
    const renderer = await renderAndReachInviteForm();

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('a@b');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    const errorNode = findHostByTestId(renderer.root, 'invite-email-input-error');
    expect(errorNode.props.children).toBe(INVALID_EMAIL_MESSAGE);
    expect(mockCreateInviteCode).not.toHaveBeenCalled();
    expect(hasErrorBanner(renderer.root)).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 2: coded EMAIL_FORMAT from server → field error, no banner, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(reasonedValidationError('EMAIL_FORMAT'));
    const renderer = await renderAndReachInviteForm();

    // A well-formed address bypasses the pre-flight so the request is genuinely issued
    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(mockCreateInviteCode).toHaveBeenCalled();
    const errorNode = findHostByTestId(renderer.root, 'invite-email-input-error');
    expect(errorNode.props.children).toBe(INVALID_EMAIL_MESSAGE);
    expect(hasErrorBanner(renderer.root)).toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 3: uncoded 400 ValidationError → banner with generic copy, no field error, one capture', async () => {
    const thrown = new ValidationError(400, 'some server text');
    mockCreateInviteCode.mockRejectedValue(thrown);
    const renderer = await renderAndReachInviteForm();

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(hasErrorBanner(renderer.root)).toBe(true);
    expect(findTextWithChildren(renderer.root, GENERIC_INVITE_FAILURE_COPY)).toBeDefined();
    // Never the raw server text — that rides only in the __DEV__ serverMessage.
    expect(findTextWithChildren(renderer.root, 'some server text')).toBeUndefined();
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'invite-email-input-error',
      ),
    ).toHaveLength(0);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = mockCaptureException.mock.calls[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError).not.toBe(thrown);
    expect(context).toEqual({
      tags: { feature: 'orbit-invite-create', status: '400', api_code: 'VALIDATION_ERROR' },
    });
  });

  it('case 4: coded but unrouted reason → generic banner, no field error, capture with validation_reason_routed:false', async () => {
    const thrown = reasonedValidationError('GROUP_FULL');
    mockCreateInviteCode.mockRejectedValue(thrown);
    const renderer = await renderAndReachInviteForm();

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(hasErrorBanner(renderer.root)).toBe(true);
    expect(findTextWithChildren(renderer.root, GENERIC_INVITE_FAILURE_COPY)).toBeDefined();
    // The screen renders its own legacy copy, NOT the GROUP_FULL copy that
    // errors.ts selected for the reason — this screen does not route it.
    expect(
      findTextWithChildren(
        renderer.root,
        'This orbit is full — ask the orbit admin to make room',
      ),
    ).toBeUndefined();
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'invite-email-input-error',
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

  it('case 5: 403 AuthError → not-allowed banner, no field error, no capture', async () => {
    mockCreateInviteCode.mockRejectedValue(new AuthError(403, 'not creator'));
    const renderer = await renderAndReachInviteForm();

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(hasErrorBanner(renderer.root)).toBe(true);
    expect(findTextWithChildren(renderer.root, NOT_ALLOWED_COPY)).toBeDefined();
    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'invite-email-input-error',
      ),
    ).toHaveLength(0);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('case 6: retyping the email after a field error clears the field error node', async () => {
    const renderer = await renderAndReachInviteForm();

    // Trigger the pre-flight field error
    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('a@b');
    });
    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'invite-email-input-error',
      ).length,
    ).toBeGreaterThan(0);

    // User retypes — error should clear
    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('member@example.com');
    });

    expect(
      renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.testID === 'invite-email-input-error',
      ),
    ).toHaveLength(0);
  });

  it('case 7: host input node carries correct keyboard props', async () => {
    const renderer = await renderAndReachInviteForm();

    const hostInput = findHostByTestId(renderer.root, 'invite-email-input');
    expect(hostInput.props.keyboardType).toBe('email-address');
    expect(hostInput.props.autoCapitalize).toBe('none');
    expect(hostInput.props.autoCorrect).toBe(false);
    expect(hostInput.props.maxLength).toBe(256);
    expect(hostInput.props.textContentType).toBeUndefined();
  });
});
