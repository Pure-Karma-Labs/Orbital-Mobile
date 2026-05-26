/**
 * Tests for ForgotPasswordScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { ForgotPasswordScreen } from '../ForgotPasswordScreen';
import { ApiError, NetworkError } from '../../services/api/errors';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/authService', () => ({
  requestPasswordReset: jest.fn(),
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { requestPasswordReset } from '../../services/authService';
const mockRequestPasswordReset = requestPasswordReset as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderForgotPasswordScreen(
  onNavigate = jest.fn(),
  email?: string,
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
          React.createElement(ForgotPasswordScreen, { onNavigate, email }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ForgotPasswordScreen — rendering', () => {
  it('renders email input and submit button', () => {
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'forgot-email-input')).not.toThrow();
    expect(() => findByTestId(root, 'forgot-submit-button')).not.toThrow();
  });

  it('renders the back link', () => {
    const renderer = renderForgotPasswordScreen();
    expect(() => findByTestId(renderer.root, 'forgot-back-link')).not.toThrow();
  });

  it('displays warning text about password reset', () => {
    const renderer = renderForgotPasswordScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const warningText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Messages on a lost device cannot be recovered'),
    );
    expect(warningText).toBeDefined();
  });

  it('pre-fills email when email prop is provided', () => {
    const renderer = renderForgotPasswordScreen(jest.fn(), 'alice@example.com');
    const emailInput = findByTestId(renderer.root, 'forgot-email-input');
    expect(emailInput.props.value).toBe('alice@example.com');
  });
});

describe('ForgotPasswordScreen — validation', () => {
  it('shows error when email is empty on submit', async () => {
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('email'),
    );
    expect(errorText).toBeDefined();
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });

  it('shows error when email has no @ symbol', async () => {
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-email-input').props.onChangeText('notanemail');
    });

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('email'),
    );
    expect(errorText).toBeDefined();
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });
});

describe('ForgotPasswordScreen — submission', () => {
  it('calls requestPasswordReset and navigates to resetPassword on success', async () => {
    mockRequestPasswordReset.mockResolvedValue(undefined);
    const onNavigate = jest.fn();
    const renderer = renderForgotPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-email-input').props.onChangeText('alice@example.com');
    });

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
    });

    expect(mockRequestPasswordReset).toHaveBeenCalledWith('alice@example.com');
    expect(onNavigate).toHaveBeenCalledWith('resetPassword', { email: 'alice@example.com' });
  });
});

describe('ForgotPasswordScreen — error handling', () => {
  it('shows rate limit message on RATE_LIMITED ApiError', async () => {
    mockRequestPasswordReset.mockRejectedValue(
      new ApiError('Rate limited', 429, 'RATE_LIMITED', true),
    );
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-email-input').props.onChangeText('alice@example.com');
    });

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Too many attempts'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows network error message on NetworkError', async () => {
    mockRequestPasswordReset.mockRejectedValue(new NetworkError('No connection'));
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-email-input').props.onChangeText('alice@example.com');
    });

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
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
    mockRequestPasswordReset.mockRejectedValue(new Error('something went wrong'));
    const renderer = renderForgotPasswordScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-email-input').props.onChangeText('alice@example.com');
    });

    await act(async () => {
      findByTestId(root, 'forgot-submit-button').props.onPress();
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

describe('ForgotPasswordScreen — navigation', () => {
  it('calls onNavigate with login when back link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderForgotPasswordScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'forgot-back-link').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('login');
  });
});
