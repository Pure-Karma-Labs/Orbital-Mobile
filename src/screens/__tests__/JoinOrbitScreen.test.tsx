/**
 * Tests for JoinOrbitScreen — invite code entry, auto-formatting, join submission, and error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { JoinOrbitScreen } from '../JoinOrbitScreen';
import {
  ApiError,
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../../services/api/errors';
import { RATE_LIMIT_MESSAGE } from '../../utils/errorMessages';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  wrap: (c: unknown) => c,
}));

jest.mock('../../services/conversationService', () => ({
  joinOrbit: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  stripInviteCode: jest.fn((s: string) => s.replace(/-/g, '').toUpperCase()),
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
  hasV2InviteCodeLength: jest.fn((s: string) => s.length === 20),
  V2_CODE_LENGTH: 20,
}));

// A code that survives the screen's own 20-character pre-flight, so tests
// exercising the joinOrbit call (success or rejection) actually reach it.
const VALID_CODE = 'ABCDEFGHJKMNPQRSTVW0';

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { joinOrbit } from '../../services/conversationService';
import * as Sentry from '@sentry/react-native';
const mockJoinOrbit = joinOrbit as jest.Mock;
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
  key: 'JoinOrbit',
  name: 'JoinOrbit' as const,
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
          React.createElement(JoinOrbitScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof JoinOrbitScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof JoinOrbitScreen>['route'],
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JoinOrbitScreen — rendering', () => {
  it('renders the form with invite code input and join button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'join-orbit-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-code-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'join-orbit-button')).not.toThrow();
  });
});

describe('JoinOrbitScreen — validation', () => {
  it('join button is disabled when code is empty', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'join-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('join button is enabled when code has non-whitespace content', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABC123');
    });
    expect(findByTestId(renderer.root, 'join-orbit-button').props.disabled).toBe(false);
  });
});

describe('JoinOrbitScreen — auto-formatting', () => {
  it('auto-formats input with dashes every 4 chars', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCD1234');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABCD-1234');
  });

  it('handles paste of 20-char code', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABCD-EFGH-JKMN-PQRS-TVW0');
  });

  it('accepts v1 8-char codes', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABC12345');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABC1-2345');
  });
});

describe('JoinOrbitScreen — submission', () => {
  it('strips dashes before calling joinOrbit', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCD1234EFGH5678JKMN');
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    // joinOrbit should receive the stripped code (no dashes)
    expect(mockJoinOrbit).toHaveBeenCalledWith('ABCD1234EFGH5678JKMN');
  });

  it('calls navigation.goBack() on successful join', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('JoinOrbitScreen — error handling', () => {
  it('shows the NetworkError message on the banner, with no field error', async () => {
    const netErr = new NetworkError('No connection');
    mockJoinOrbit.mockRejectedValue(netErr);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, netErr.message)).toBeDefined();
    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('shows RATE_LIMIT_MESSAGE on the banner for a RATE_LIMITED ApiError, with no field error', async () => {
    mockJoinOrbit.mockRejectedValue(
      new ApiError('Too many requests', 429, 'RATE_LIMITED', false),
    );
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, RATE_LIMIT_MESSAGE)).toBeDefined();
    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
  });

  it('shows the field error for a ValidationError', async () => {
    mockJoinOrbit.mockRejectedValue(new ValidationError(400, 'used'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findByTestId(renderer.root, 'invite-code-input-error').props.children).toBe(
      'Invalid or expired invite code',
    );
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('shows the field error for a NotFoundError', async () => {
    mockJoinOrbit.mockRejectedValue(new NotFoundError());
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findByTestId(renderer.root, 'invite-code-input-error').props.children).toBe(
      'Invalid or expired invite code',
    );
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('shows the already-a-member banner for a ConflictError, with no field error', async () => {
    mockJoinOrbit.mockRejectedValue(new ConflictError());
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(
      findTextWithChildren(renderer.root, 'You are already a member of this orbit'),
    ).toBeDefined();
    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
  });

  it('shows a generic banner for an unrecognized error, with no field error and no raw message, and reports to Sentry', async () => {
    const err = new Error('boom');
    mockJoinOrbit.mockRejectedValue(err);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(
      findTextWithChildren(renderer.root, 'Could not join orbit — please try again'),
    ).toBeDefined();
    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
    expect(findTextWithChildren(renderer.root, 'boom')).toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = mockCaptureException.mock.calls[0];
    // #746: the screen reports through `captureError`, which sends a REBUILT
    // Error — class name plus scrubbed message, nothing the thrower hung off
    // the object. So this is deliberately NOT the instance we rejected with.
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError).not.toBe(err);
    expect((reportedError as Error).name).toBe('Error');
    expect((reportedError as Error).message).toBe('boom');
    // Exact match, not objectContaining: `captureError` omits `level`/`extra`
    // when the call site passed neither, and a non-ApiError adds no
    // status/api_code tags (#746).
    expect(context).toEqual({ tags: { feature: 'orbit-join' } });
  });

  it('shows the email-mismatch banner for a 403 AuthError, with no field error', async () => {
    mockJoinOrbit.mockRejectedValue(new AuthError(403, 'email mismatch'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(
      findTextWithChildren(
        renderer.root,
        'This invite is not for this account — check you are signed in with the invited email',
      ),
    ).toBeDefined();
    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('shows the generic banner for a 401 AuthError, proving the 403 branch is status-specific', async () => {
    mockJoinOrbit.mockRejectedValue(new AuthError(401));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(
      findTextWithChildren(renderer.root, 'Could not join orbit — please try again'),
    ).toBeDefined();
  });

  it('rejects a 19-character code at the pre-flight without calling joinOrbit', async () => {
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(
        'ABCDEFGHJKMNPQRSTVW',
      );
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findByTestId(renderer.root, 'invite-code-input-error').props.children).toBe(
      'Invalid invite code format — must be a 20-character v2 code',
    );
    expect(mockJoinOrbit).not.toHaveBeenCalled();
  });

  it('clears the field error when the code is edited', async () => {
    mockJoinOrbit.mockRejectedValue(new ValidationError(400, 'used'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).not.toThrow();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(
        'ZYXWVUTSRQPNMKJHGFE1',
      );
    });

    expect(() => findByTestId(renderer.root, 'invite-code-input-error')).toThrow();
  });

  it('clears the banner when the code is edited', async () => {
    const netErr = new NetworkError('No connection');
    mockJoinOrbit.mockRejectedValue(netErr);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(findTextWithChildren(renderer.root, netErr.message)).toBeDefined();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(
        'ZYXWVUTSRQPNMKJHGFE1',
      );
    });

    expect(findTextWithChildren(renderer.root, netErr.message)).toBeUndefined();
  });
});

describe('JoinOrbitScreen — loading state', () => {
  it('calls joinOrbit once and navigates on resolution', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText(VALID_CODE);
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(mockJoinOrbit).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});
