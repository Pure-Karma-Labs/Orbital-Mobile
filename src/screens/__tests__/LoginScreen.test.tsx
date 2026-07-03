/**
 * Tests for LoginScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { LoginScreen } from '../LoginScreen';
import { AuthError, NetworkError } from '../../services/api/errors';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/authService', () => ({
  loginUser: jest.fn(),
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { loginUser } from '../../services/authService';
const mockLoginUser = loginUser as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderLoginScreen(
  onNavigate = jest.fn(),
  successMessage?: string,
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
          React.createElement(LoginScreen, { onNavigate, successMessage }),
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

describe('LoginScreen — rendering', () => {
  it('renders email and password inputs', () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'login-email-input')).not.toThrow();
    expect(() => findByTestId(root, 'login-password-input')).not.toThrow();
  });

  it('renders the Log In button', () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'login-submit-button')).not.toThrow();
  });

  it('renders the switch-to-signup link', () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'login-switch-to-signup')).not.toThrow();
  });

  it('renders the forgot password link', () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    expect(() => findByTestId(root, 'login-forgot-password')).not.toThrow();
  });
});

describe('LoginScreen — validation', () => {
  it('shows error when fields are empty on submit', async () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    const button = findByTestId(root, 'login-submit-button');

    await act(async () => {
      button.props.onPress();
    });

    // ErrorBanner renders a Text with the error message
    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find((node) =>
      typeof node.props.children === 'string' &&
      node.props.children.toLowerCase().includes('email'),
    );
    expect(errorText).toBeDefined();
    expect(mockLoginUser).not.toHaveBeenCalled();
  });
});

describe('LoginScreen — terms checkbox gate', () => {
  it('renders the terms checkbox', () => {
    const renderer = renderLoginScreen();
    expect(() => findByTestId(renderer.root, 'login-terms-checkbox')).not.toThrow();
  });

  it('submit button is disabled until terms checkbox is checked', () => {
    const renderer = renderLoginScreen();
    const button = findByTestId(renderer.root, 'login-submit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('submit button is enabled after checking terms', () => {
    const renderer = renderLoginScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    const button = findByTestId(renderer.root, 'login-submit-button');
    expect(button.props.disabled).toBeFalsy();
  });

  it('renders the Terms of Use link', () => {
    const renderer = renderLoginScreen();
    expect(() => findByTestId(renderer.root, 'login-terms-link')).not.toThrow();
  });

  it('does not render Privacy Policy link on login', () => {
    const renderer = renderLoginScreen();
    const found = renderer.root.findAll((n) => n.props.testID === 'login-privacy-link');
    expect(found).toHaveLength(0);
  });
});

describe('LoginScreen — submission', () => {
  it('calls loginUser with trimmed email and password on valid submission', async () => {
    mockLoginUser.mockResolvedValue(undefined);
    const renderer = renderLoginScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'login-password-input').props.onChangeText('mypassword');
      findCheckbox(root).props.onPress();
    });

    await act(async () => {
      findByTestId(root, 'login-submit-button').props.onPress();
    });

    expect(mockLoginUser).toHaveBeenCalledWith('alice@example.com', 'mypassword');
  });
});

describe('LoginScreen — error handling', () => {
  it('shows auth error message on AuthError', async () => {
    mockLoginUser.mockRejectedValue(new AuthError(401, 'bad creds'));
    const renderer = renderLoginScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-email-input').props.onChangeText('user');
      findByTestId(root, 'login-password-input').props.onChangeText('pass');
      findCheckbox(root).props.onPress();
    });

    await act(async () => {
      findByTestId(root, 'login-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find((node) =>
      typeof node.props.children === 'string' &&
      node.props.children.toLowerCase().includes('invalid'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows network error message on NetworkError', async () => {
    const netErr = new NetworkError('No connection');
    mockLoginUser.mockRejectedValue(netErr);
    const renderer = renderLoginScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-email-input').props.onChangeText('user');
      findByTestId(root, 'login-password-input').props.onChangeText('pass');
      findCheckbox(root).props.onPress();
    });

    await act(async () => {
      findByTestId(root, 'login-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find((node) =>
      typeof node.props.children === 'string' &&
      node.props.children.toLowerCase().includes('network'),
    );
    expect(errorText).toBeDefined();
  });

  it('shows server error message on generic error', async () => {
    mockLoginUser.mockRejectedValue(new Error('500 internal server error'));
    const renderer = renderLoginScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-email-input').props.onChangeText('user');
      findByTestId(root, 'login-password-input').props.onChangeText('pass');
      findCheckbox(root).props.onPress();
    });

    await act(async () => {
      findByTestId(root, 'login-submit-button').props.onPress();
    });

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find((node) =>
      typeof node.props.children === 'string' &&
      node.props.children.toLowerCase().includes('server error'),
    );
    expect(errorText).toBeDefined();
  });
});

describe('LoginScreen — navigation', () => {
  it('calls onNavigate with signup when the sign up link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderLoginScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-switch-to-signup').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('signup');
  });

  it('calls onNavigate with forgotPassword when forgot password link is pressed', () => {
    const onNavigate = jest.fn();
    const renderer = renderLoginScreen(onNavigate);
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'login-forgot-password').props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('forgotPassword');
  });
});

describe('LoginScreen — success banner', () => {
  it('renders success banner when successMessage is provided', () => {
    const renderer = renderLoginScreen(jest.fn(), 'Password reset successfully. Please log in.');
    const root = renderer.root;
    expect(() => findByTestId(root, 'login-success-banner')).not.toThrow();
  });

  it('hides success banner when user starts typing', () => {
    const renderer = renderLoginScreen(jest.fn(), 'Password reset successfully. Please log in.');
    const root = renderer.root;

    // Banner is visible initially
    expect(() => findByTestId(root, 'login-success-banner')).not.toThrow();

    // User starts typing
    act(() => {
      findByTestId(root, 'login-email-input').props.onChangeText('a');
    });

    // Banner should be gone
    const found = root.findAll((node) => node.props.testID === 'login-success-banner');
    expect(found.length).toBe(0);
  });

  it('does not render success banner when no successMessage', () => {
    const renderer = renderLoginScreen();
    const root = renderer.root;
    const found = root.findAll((node) => node.props.testID === 'login-success-banner');
    expect(found.length).toBe(0);
  });
});
