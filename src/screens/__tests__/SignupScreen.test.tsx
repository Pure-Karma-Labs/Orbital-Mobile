/**
 * Tests for SignupScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { SignupScreen } from '../SignupScreen';
import { ApiError, AuthError, NetworkError, ValidationError } from '../../services/api/errors';
import { PASSWORD_RULE_HINT } from '../../utils/validatePassword';
import { RATE_LIMIT_MESSAGE } from '../../utils/errorMessages';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// The screen reports unknown/absent validation reasons through the real
// `captureError`, exactly as JoinOrbitScreen does (#746) — so Sentry is the
// boundary that gets mocked, not our telemetry wrapper. That keeps the tag
// shape under test instead of stubbing it out.
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  wrap: (c: unknown) => c,
}));

jest.mock('../../services/authService', () => ({
  signupUser: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
  stripInviteCode: jest.fn((s: string) => s.replace(/-/g, '').toUpperCase()),
  hasV2InviteCodeLength: jest.fn((s: string) => s.length === 20),
  V2_CODE_LENGTH: 20,
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { signupUser } from '../../services/authService';
import * as Sentry from '@sentry/react-native';
const mockSignupUser = signupUser as jest.Mock;
const mockCaptureException = Sentry.captureException as unknown as jest.Mock;

// Curated client copy for each backend reason code. Spelled out as literals on
// purpose: importing the map from errors.ts would make every assertion below a
// tautology that could not catch a copy edit or a mis-routed channel.
const REASON_COPY = {
  INVITE_INVALID: 'This invite code is not valid — check it and try again',
  INVITE_USED: 'This invite code has already been used — ask for a new invite',
  INVITE_CANCELLED: 'This invite code has been cancelled — ask for a new invite',
  INVITE_EXPIRED: 'This invite code has expired — ask for a new invite',
  INVITE_EMAIL_MISMATCH:
    'This invite code was sent to a different email address — sign up with that address',
  EMAIL_FORMAT: 'Please enter a valid email address',
} as const;

/** A 400 shaped exactly like the backend's: top-level error, message, details.code. */
function reasonedValidationError(code: string, message = 'server-side wording'): ValidationError {
  return new ValidationError(
    400,
    JSON.stringify({ error: 'VALIDATION_ERROR', message, details: { code } }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderSignupScreen(onNavigate = jest.fn()): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: safeAreaMetrics },
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(SignupScreen, { onNavigate }),
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

/**
 * True when the banner is actually in the rendered output. Deliberately filtered
 * to host nodes: `ErrorBanner` carries `testID` as a prop even on the render
 * that returns null, so a plain testID lookup would "find" a hidden banner and
 * make every absence assertion vacuous.
 */
function hasErrorBanner(root: ReactTestInstance): boolean {
  return (
    root.findAll(
      (node) => typeof node.type === 'string' && node.props.testID === 'signup-error-banner',
    ).length > 0
  );
}

function findTextWithChildren(
  root: ReactTestInstance,
  text: string,
): ReactTestInstance | undefined {
  return root
    .findAllByType('Text' as unknown as React.ComponentType)
    .find((node) => node.props.children === text);
}

function findCheckbox(root: ReactTestInstance): ReactTestInstance {
  const found = root.findAll((node) => node.props.accessibilityRole === 'checkbox');
  if (found.length === 0) throw new Error('No element with accessibilityRole "checkbox"');
  return found[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SignupScreen — rendering', () => {
  it('renders all 4 input fields', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'signup-username-input')).not.toThrow();
    expect(() => findByTestId(root, 'signup-email-input')).not.toThrow();
    expect(() => findByTestId(root, 'signup-password-input')).not.toThrow();
    expect(() => findByTestId(root, 'signup-invite-code-input')).not.toThrow();
  });

  it('renders the Sign Up button', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-submit-button')).not.toThrow();
  });

  it('renders the switch-to-login link', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-switch-to-login')).not.toThrow();
  });
});

describe('SignupScreen — validation', () => {
  it('shows error when all fields are empty on submit', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const button = findByTestId(root, 'signup-submit-button');

    await act(async () => {
      button.props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('required'),
    );
    expect(errorText).toBeDefined();
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the exact email-format message on the email field for a malformed email', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('notanemail');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('INVITE');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-email-input-error').props.children).toBe(
      'Please enter a valid email address',
    );
    expect(hasErrorBanner(root)).toBe(false);
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it("blocks 'a@b' pre-flight — looser than includes('@') would be", async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('a@b');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-email-input-error').props.children).toBe(
      'Please enter a valid email address',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows error when only some fields are filled', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      // email, password, invite left empty
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(mockSignupUser).not.toHaveBeenCalled();
  });
});

describe('SignupScreen — field-level validation errors', () => {
  it('shows the length rule message for a too-short password', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('Short1Aa');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must be at least 12 characters',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the uppercase rule message when the password has no uppercase letter', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('nouppercase123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must contain at least one uppercase letter',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the number rule message when the password has no digit', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('NoNumbersHereAtAll');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must contain at least one number',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the length rule message for a too-short username', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('ab');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-username-input-error').props.children).toBe(
      'Username must be between 3 and 50 characters',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the character-set rule message for a username with a space', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('bad name');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-username-input-error').props.children).toBe(
      'Username can only contain letters, numbers, and underscores',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the invite code format message for a 19-character code', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-invite-code-input-error').props.children).toBe(
      'Invalid invite code format — must be a 20-character v2 code',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the persistent password rule hint on mount', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    expect(findByTestId(root, 'signup-password-input-helper').props.children).toBe(
      PASSWORD_RULE_HINT,
    );
  });

  it('clears the password field error when the password is edited', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('Short1Aa');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(() => findByTestId(root, 'signup-password-input-error')).not.toThrow();

    act(() => {
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
    });

    expect(() => findByTestId(root, 'signup-password-input-error')).toThrow();
  });

  it('clears the username field error when the username is edited', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('ab');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(() => findByTestId(root, 'signup-username-input-error')).not.toThrow();

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
    });

    expect(() => findByTestId(root, 'signup-username-input-error')).toThrow();
  });

  it('clears the invite code field error when a valid code is typed', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(() => findByTestId(root, 'signup-invite-code-input-error')).not.toThrow();

    act(() => {
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    expect(() => findByTestId(root, 'signup-invite-code-input-error')).toThrow();
  });

  it('shows the length rule message for a 51-character username', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('a'.repeat(51));
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-username-input-error').props.children).toBe(
      'Username must be between 3 and 50 characters',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('shows the lowercase rule message when the password has no lowercase letter', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('ALLUPPER12345678');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must contain at least one lowercase letter',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('clears the stale required-fields banner and shows the password field error on a second submit, without ever calling signupUser', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(hasErrorBanner(root)).toBe(true);
    expect(findTextWithChildren(root, 'All fields are required')).toBeDefined();

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('short');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    // The banner itself is gone — not merely this one string — so a stale
    // guard message can never sit beside a fresh field error (#777).
    expect(hasErrorBanner(root)).toBe(false);
    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must be at least 12 characters',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('surfaces the email guard as a field error ahead of the password rule check', async () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('notanemail');
      findByTestId(root, 'signup-password-input').props.onChangeText('short');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'signup-email-input-error').props.children).toBe(
      'Please enter a valid email address',
    );
    expect(hasErrorBanner(root)).toBe(false);
    expect(() => findByTestId(root, 'signup-password-input-error')).toThrow();
    expect(mockSignupUser).not.toHaveBeenCalled();
  });
});

describe('SignupScreen — submission', () => {
  it('calls signupUser with stripped invite code on valid submission', async () => {
    mockSignupUser.mockResolvedValue(undefined);
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
    });

    // Simulate typing a v2 invite code — the handler auto-formats it
    act(() => {
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });

    // Accept terms before submitting
    act(() => {
      findCheckbox(root).props.onPress();
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    // stripInviteCode removes dashes and uppercases
    expect(mockSignupUser).toHaveBeenCalledWith(
      'alice',
      'StrongPass123',
      'alice@example.com',
      'ABCDEFGHJKMNPQRSTVW0',
    );
  });
});

describe('SignupScreen — error handling', () => {
  function fillValidFields(root: ReactTestInstance): void {
    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
      findCheckbox(root).props.onPress();
    });
  }

  it('shows auth error message on AuthError', async () => {
    mockSignupUser.mockRejectedValue(new AuthError(401, 'bad invite'));
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('authentication'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows auth error message on ValidationError', async () => {
    mockSignupUser.mockRejectedValue(new ValidationError(400, 'username taken'));
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('invalid'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows network error message on NetworkError', async () => {
    const netErr = new NetworkError('No connection');
    mockSignupUser.mockRejectedValue(netErr);
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('network'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows server error message on generic error', async () => {
    mockSignupUser.mockRejectedValue(new Error('500 internal server error'));
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('server error'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows a rate-limit message on RATE_LIMITED ApiError', async () => {
    mockSignupUser.mockRejectedValue(
      new ApiError('Too many requests', 429, 'RATE_LIMITED', false),
    );
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === RATE_LIMIT_MESSAGE,
    );
    expect(errorText).toBeDefined();
  });
});

describe('SignupScreen — server validation reasons (#783)', () => {
  function fillValidFields(root: ReactTestInstance): void {
    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('StrongPass123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
      findCheckbox(root).props.onPress();
    });
  }

  async function submitWith(error: unknown): Promise<ReactTestInstance> {
    mockSignupUser.mockRejectedValue(error);
    const renderer = renderSignupScreen();
    const root = renderer.root;
    fillValidFields(root);
    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });
    return root;
  }

  it.each([
    ['INVITE_EXPIRED', REASON_COPY.INVITE_EXPIRED],
    ['INVITE_USED', REASON_COPY.INVITE_USED],
    ['INVITE_CANCELLED', REASON_COPY.INVITE_CANCELLED],
    ['INVITE_INVALID', REASON_COPY.INVITE_INVALID],
  ])('routes %s to the invite field with its curated copy and no banner', async (code, copy) => {
    const root = await submitWith(reasonedValidationError(code));

    expect(findByTestId(root, 'signup-invite-code-input-error').props.children).toBe(copy);
    expect(hasErrorBanner(root)).toBe(false);
    expect(() => findByTestId(root, 'signup-email-input-error')).toThrow();
  });

  it('routes INVITE_EMAIL_MISMATCH to the banner — the pair is wrong, not one field', async () => {
    const root = await submitWith(reasonedValidationError('INVITE_EMAIL_MISMATCH'));

    expect(hasErrorBanner(root)).toBe(true);
    expect(findTextWithChildren(root, REASON_COPY.INVITE_EMAIL_MISMATCH)).toBeDefined();
    expect(() => findByTestId(root, 'signup-invite-code-input-error')).toThrow();
    expect(() => findByTestId(root, 'signup-email-input-error')).toThrow();
  });

  it('routes EMAIL_FORMAT to the email field', async () => {
    const root = await submitWith(reasonedValidationError('EMAIL_FORMAT'));

    expect(findByTestId(root, 'signup-email-input-error').props.children).toBe(
      REASON_COPY.EMAIL_FORMAT,
    );
    expect(hasErrorBanner(root)).toBe(false);
  });

  it('never renders the generic copy for a reasoned error', async () => {
    const root = await submitWith(reasonedValidationError('INVITE_EXPIRED'));

    expect(findTextWithChildren(root, 'Invalid request')).toBeUndefined();
    expect(findTextWithChildren(root, 'Signup failed')).toBeUndefined();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('falls back to the generic banner for an unknown code, leaking no server text', async () => {
    const root = await submitWith(
      reasonedValidationError('SOME_FUTURE_CODE', 'SECRET-server-text'),
    );

    expect(hasErrorBanner(root)).toBe(true);
    expect(findTextWithChildren(root, 'Invalid request')).toBeDefined();

    // Nothing the server wrote reaches the screen, on any node.
    const rendered = root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => String(node.props.children))
      .join('\u0000');
    expect(rendered).not.toContain('SECRET');
    expect(rendered).not.toContain('SOME_FUTURE_CODE');

    // Reported, but content-free: the tag says only that the code was unknown.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, context] = mockCaptureException.mock.calls[0];
    expect(context).toEqual({
      tags: {
        feature: 'signup',
        validation_reason_known: 'false',
        status: '400',
        api_code: 'VALIDATION_ERROR',
      },
    });
    expect(JSON.stringify(mockCaptureException.mock.calls[0])).not.toContain('SECRET');
  });

  it('clears a server invite error when the invite code is edited', async () => {
    const root = await submitWith(reasonedValidationError('INVITE_EXPIRED'));

    expect(() => findByTestId(root, 'signup-invite-code-input-error')).not.toThrow();

    act(() => {
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('ZYXWVTSRQPNMKJHGFEDC');
    });

    expect(() => findByTestId(root, 'signup-invite-code-input-error')).toThrow();
  });

  it('clears the stale server banner and shows the email field error on the next submit', async () => {
    const root = await submitWith(reasonedValidationError('INVITE_EMAIL_MISMATCH'));

    expect(hasErrorBanner(root)).toBe(true);

    act(() => {
      findByTestId(root, 'signup-email-input').props.onChangeText('a@b');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(hasErrorBanner(root)).toBe(false);
    expect(findByTestId(root, 'signup-email-input-error').props.children).toBe(
      REASON_COPY.EMAIL_FORMAT,
    );
    // Blocked pre-flight: the one call is the first submit, not this one.
    expect(mockSignupUser).toHaveBeenCalledTimes(1);
  });
});

describe('SignupScreen — navigation', () => {
  it('calls onNavigate with login when the log in link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderSignupScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-switch-to-login').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('login');
  });
});

describe('SignupScreen — invite code auto-format', () => {
  it('auto-formats invite code input with dashes', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const input = findByTestId(root, 'signup-invite-code-input');

    act(() => {
      input.props.onChangeText('ABCDEFGHJK');
    });

    // Should be formatted as ABCD-EFGH-JK
    expect(input.props.value).toBe('ABCD-EFGH-JK');
  });

  it('strips non-alphanumeric characters from invite code input', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const input = findByTestId(root, 'signup-invite-code-input');

    act(() => {
      input.props.onChangeText('AB-CD!EF@GH');
    });

    // Non-alphanumeric stripped, then formatted
    expect(input.props.value).toBe('ABCD-EFGH');
  });

  it('uppercases lowercase invite code input', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const input = findByTestId(root, 'signup-invite-code-input');

    act(() => {
      input.props.onChangeText('abcdefgh');
    });

    expect(input.props.value).toBe('ABCD-EFGH');
  });

  it('limits invite code to 20 characters (before formatting)', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const input = findByTestId(root, 'signup-invite-code-input');

    act(() => {
      input.props.onChangeText('ABCDEFGHJKMNPQRSTVW0EXTRACHARACTERS');
    });

    // Should be capped at 20 chars raw, formatted as XXXX-XXXX-XXXX-XXXX-XXXX
    expect(input.props.value).toBe('ABCD-EFGH-JKMN-PQRS-TVW0');
  });

  it('sets empty string for empty input', () => {
    const renderer = renderSignupScreen();
    const root = renderer.root;
    const input = findByTestId(root, 'signup-invite-code-input');

    // First set a value
    act(() => {
      input.props.onChangeText('ABCD');
    });
    expect(input.props.value).toBe('ABCD');

    // Then clear it
    act(() => {
      input.props.onChangeText('');
    });
    expect(input.props.value).toBe('');
  });

  it('has maxLength of 24 and placeholder for v2 code format', () => {
    const renderer = renderSignupScreen();
    const input = findByTestId(renderer.root, 'signup-invite-code-input');
    expect(input.props.maxLength).toBe(24);
    expect(input.props.placeholder).toBe('XXXX-XXXX-XXXX-XXXX-XXXX');
  });
});

describe('SignupScreen — terms checkbox gate', () => {
  it('renders the terms checkbox', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-terms-checkbox')).not.toThrow();
  });

  it('submit button is disabled until terms checkbox is checked', () => {
    const renderer = renderSignupScreen();
    const button = findByTestId(renderer.root, 'signup-submit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('submit button is enabled after checking terms', () => {
    const renderer = renderSignupScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    const button = findByTestId(renderer.root, 'signup-submit-button');
    expect(button.props.disabled).toBeFalsy();
  });

  it('renders the Terms of Use link', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-terms-link')).not.toThrow();
  });

  it('renders the Privacy Policy link', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-privacy-link')).not.toThrow();
  });
});

describe('SignupScreen — legal links', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    (Linking.openURL as jest.Mock).mockRestore();
  });

  it('opens the terms URL when Terms of Use is pressed', () => {
    const renderer = renderSignupScreen();
    const termsLink = findByTestId(renderer.root, 'signup-terms-link');

    act(() => {
      termsLink.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://orbitl.org/terms');
  });

  it('opens the privacy URL when Privacy Policy is pressed', () => {
    const renderer = renderSignupScreen();
    const privacyLink = findByTestId(renderer.root, 'signup-privacy-link');

    act(() => {
      privacyLink.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://orbitl.org/privacy');
  });
});
