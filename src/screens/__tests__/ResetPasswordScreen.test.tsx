/**
 * Tests for ResetPasswordScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ResetPasswordScreen } from '../ResetPasswordScreen';
import { ApiError, NetworkError, ValidationError } from '../../services/api/errors';
import { PASSWORD_RULE_HINT } from '../../utils/validatePassword';
import { bannerMessage, findByTestId, queryByText } from '../../testUtils/rtr';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/authService', () => ({
  resetPassword: jest.fn(),
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { resetPassword } from '../../services/authService';
const mockResetPassword = resetPassword as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderResetPasswordScreen(
  onNavigate = jest.fn(),
  email = 'alice@example.com',
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: safeAreaMetrics },
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(ResetPasswordScreen, { onNavigate, email }),
        ),
      ),
    );
  });
  return renderer;
}

function fillValidFields(root: ReactTestInstance): void {
  act(() => {
    findByTestId(root, 'reset-code-input').props.onChangeText('ABCD1234');
    findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
    findByTestId(root, 'reset-confirm-password-input').props.onChangeText('NewPassword123');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ResetPasswordScreen — rendering', () => {
  it('renders all input fields', () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'reset-code-input')).not.toThrow();
    expect(() => findByTestId(root, 'reset-new-password-input')).not.toThrow();
    expect(() => findByTestId(root, 'reset-confirm-password-input')).not.toThrow();
    // No banner on first render — the never-set path. Pins `bannerMessage`'s
    // host filter: `ErrorBanner` still carries its testID on the render that
    // returns null, so an unfiltered lookup would find a hidden banner (#872).
    expect(bannerMessage(root, 'reset-password-error-banner')).toBeUndefined();
  });

  it('renders the submit button', () => {
    const renderer = renderResetPasswordScreen();
    expect(() => findByTestId(renderer.root, 'reset-submit-button')).not.toThrow();
  });

  it('displays masked email', () => {
    const renderer = renderResetPasswordScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const infoText = allText.find((node) => {
      const children = node.props.children;
      if (typeof children === 'string') {
        return children.includes('a***@example.com');
      }
      if (Array.isArray(children)) {
        return children.join('').includes('a***@example.com');
      }
      return false;
    });
    expect(infoText).toBeDefined();
  });

  it('renders resend and back links', () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'reset-resend-link')).not.toThrow();
    expect(() => findByTestId(root, 'reset-back-link')).not.toThrow();
  });
});

describe('ResetPasswordScreen — code normalization', () => {
  it('strips dashes and spaces from code before submission', async () => {
    mockResetPassword.mockResolvedValue(undefined);
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABCD-1234');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('NewPassword123');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(mockResetPassword).toHaveBeenCalledWith(
      'alice@example.com',
      'ABCD1234',
      'NewPassword123',
    );
  });

  it('strips whitespace from code', async () => {
    mockResetPassword.mockResolvedValue(undefined);
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText(' abcd 1234 ');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('NewPassword123');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(mockResetPassword).toHaveBeenCalledWith(
      'alice@example.com',
      'ABCD1234',
      'NewPassword123',
    );
  });
});

describe('ResetPasswordScreen — validation', () => {
  it('shows error when code is too short', async () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABC');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('NewPassword123');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'reset-code-input-error').props.children).toBe(
      'Reset code must be 8 characters',
    );
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('shows error when passwords do not match', async () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABCD1234');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('DifferentPass1');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('match'),
    );
    expect(errorText).toBeDefined();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('shows error when password is too weak', async () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABCD1234');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('short');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('short');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'reset-new-password-input-error').props.children).toBe(
      'Password must be at least 12 characters',
    );
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('shows the persistent password rule hint on mount', () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    expect(findByTestId(root, 'reset-new-password-input-helper').props.children).toBe(
      PASSWORD_RULE_HINT,
    );
  });

  it('clears the stale mismatch banner and shows the password field error on a second submit, without ever calling resetPassword', async () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABCD1234');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('DifferentPass1');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(queryByText(root, 'Passwords do not match')).toBeDefined();

    act(() => {
      findByTestId(root, 'reset-new-password-input').props.onChangeText('short');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('short');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(queryByText(root, 'Passwords do not match')).toBeUndefined();
    expect(findByTestId(root, 'reset-new-password-input-error').props.children).toBe(
      'Password must be at least 12 characters',
    );
    expect(mockResetPassword).not.toHaveBeenCalled();
  });
});

describe('ResetPasswordScreen — submission', () => {
  it('calls resetPassword with correct args on valid submission', async () => {
    mockResetPassword.mockResolvedValue(undefined);
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(mockResetPassword).toHaveBeenCalledWith(
      'alice@example.com',
      'ABCD1234',
      'NewPassword123',
    );
  });

  it('navigates to login with success message on success', async () => {
    mockResetPassword.mockResolvedValue(undefined);
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('login', {
      successMessage: 'Password reset successfully. Please log in.',
    });
  });
});

describe('ResetPasswordScreen — error handling', () => {
  it('shows rate limit message on RATE_LIMITED ApiError', async () => {
    mockResetPassword.mockRejectedValue(
      new ApiError('Rate limited', 429, 'RATE_LIMITED', true),
    );
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Too many attempts'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows invalid code message on ValidationError', async () => {
    mockResetPassword.mockRejectedValue(new ValidationError(400, 'invalid code'));
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(findByTestId(root, 'reset-code-input-error').props.children).toBe(
      'Invalid or expired code',
    );
  });

  it('routes a coded EMAIL_FORMAT ValidationError to the banner, not the code field', async () => {
    mockResetPassword.mockRejectedValue(
      new ValidationError(
        400,
        JSON.stringify({
          error: 'VALIDATION_ERROR',
          message: 'Invalid email format',
          details: { code: 'EMAIL_FORMAT' },
        }),
      ),
    );
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(bannerMessage(root, 'reset-password-error-banner')).toBe(
      'Please enter a valid email address',
    );
    expect(queryByText(root, 'Invalid or expired code')).toBeUndefined();
    expect(() => findByTestId(root, 'reset-code-input-error')).toThrow();
  });

  it('routes any reasoned ValidationError to the banner, never blaming the code field', async () => {
    mockResetPassword.mockRejectedValue(
      new ValidationError(
        400,
        JSON.stringify({
          error: 'VALIDATION_ERROR',
          message: 'x',
          details: { code: 'INVITE_EXPIRED' },
        }),
      ),
    );
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(bannerMessage(root, 'reset-password-error-banner')).toBe(
      'This invite code has expired — ask for a new invite',
    );
    expect(() => findByTestId(root, 'reset-code-input-error')).toThrow();
  });

  it('clears the code field error when the code is edited', async () => {
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABC');
      findByTestId(root, 'reset-new-password-input').props.onChangeText('NewPassword123');
      findByTestId(root, 'reset-confirm-password-input').props.onChangeText('NewPassword123');
    });

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    expect(() => findByTestId(root, 'reset-code-input-error')).not.toThrow();

    act(() => {
      findByTestId(root, 'reset-code-input').props.onChangeText('ABCD1234');
    });

    expect(() => findByTestId(root, 'reset-code-input-error')).toThrow();
  });

  it('shows network error message on NetworkError', async () => {
    mockResetPassword.mockRejectedValue(new NetworkError('No connection'));
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
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
    mockResetPassword.mockRejectedValue(new Error('unexpected'));
    const renderer = renderResetPasswordScreen();
    const root = renderer.root;
    fillValidFields(root);

    await act(async () => {
      findByTestId(root, 'reset-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('server error'),
    );
    expect(errorText).toBeDefined();
  });
});

describe('ResetPasswordScreen — navigation', () => {
  it('calls onNavigate with forgotPassword when resend link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-resend-link').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('forgotPassword', { email: 'alice@example.com' });
  });

  it('calls onNavigate with forgotPassword when back link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderResetPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'reset-back-link').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('forgotPassword', { email: 'alice@example.com' });
  });
});
