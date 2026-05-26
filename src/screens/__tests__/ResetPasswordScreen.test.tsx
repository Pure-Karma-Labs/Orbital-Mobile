/**
 * Tests for ResetPasswordScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ResetPasswordScreen } from '../ResetPasswordScreen';
import { ApiError, NetworkError, ValidationError } from '../../services/api/errors';

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

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
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

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('8 characters'),
    );
    expect(errorText).toBeDefined();
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

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('12 characters'),
    );
    expect(errorText).toBeDefined();
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

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Invalid or expired code'),
    );
    expect(errorText).toBeDefined();
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
