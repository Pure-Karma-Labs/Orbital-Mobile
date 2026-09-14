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

jest.mock('../../services/authService', () => ({
  signupUser: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
  stripInviteCode: jest.fn((s: string) => s.replace(/-/g, '').toUpperCase()),
  isValidV2InviteCode: jest.fn((s: string) => s.length === 20),
  V2_CODE_LENGTH: 20,
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { signupUser } from '../../services/authService';
const mockSignupUser = signupUser as jest.Mock;

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

  it('shows error when email does not contain @', async () => {
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

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('email'),
    );
    expect(errorText).toBeDefined();
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

  it('clears the stale email banner and shows the password field error on a second submit, without ever calling signupUser', async () => {
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

    const findEmailBanner = () =>
      root
        .findAllByType('Text' as unknown as React.ComponentType)
        .find(
          (node) =>
            typeof node.props.children === 'string' &&
            node.props.children === 'Please enter a valid email address',
        );

    expect(findEmailBanner()).toBeDefined();

    act(() => {
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(findEmailBanner()).toBeUndefined();
    expect(findByTestId(root, 'signup-password-input-error').props.children).toBe(
      'Password must be at least 12 characters',
    );
    expect(mockSignupUser).not.toHaveBeenCalled();
  });

  it('surfaces the email guard on the banner ahead of the password field error', async () => {
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

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Please enter a valid email address',
    );
    expect(errorText).toBeDefined();
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
