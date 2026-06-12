/**
 * Tests for SignupScreen — rendering, validation, submission, error handling.
 */

import React from 'react';
import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { SignupScreen } from '../SignupScreen';
import { AuthError, NetworkError, ValidationError } from '../../services/api/errors';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/authService', () => ({
  signupUser: jest.fn(),
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
      findByTestId(root, 'signup-password-input').props.onChangeText('password123');
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

describe('SignupScreen — submission', () => {
  it('calls signupUser with all fields on valid submission', async () => {
    mockSignupUser.mockResolvedValue(undefined);
    const renderer = renderSignupScreen();
    const root = renderer.root;

    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('password123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('INVITE123');
    });

    await act(async () => {
      findByTestId(root, 'signup-submit-button').props.onPress();
    });

    expect(mockSignupUser).toHaveBeenCalledWith(
      'alice',
      'password123',
      'alice@example.com',
      'INVITE123',
    );
  });
});

describe('SignupScreen — error handling', () => {
  function fillValidFields(root: ReactTestInstance): void {
    act(() => {
      findByTestId(root, 'signup-username-input').props.onChangeText('alice');
      findByTestId(root, 'signup-email-input').props.onChangeText('alice@example.com');
      findByTestId(root, 'signup-password-input').props.onChangeText('password123');
      findByTestId(root, 'signup-invite-code-input').props.onChangeText('INVITE');
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

describe('SignupScreen — legal links', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    (Linking.openURL as jest.Mock).mockRestore();
  });

  it('renders the Terms of Service link', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-terms-link')).not.toThrow();
  });

  it('renders the Privacy Policy link', () => {
    const renderer = renderSignupScreen();
    expect(() => findByTestId(renderer.root, 'signup-privacy-link')).not.toThrow();
  });

  it('opens the terms URL when Terms of Service is pressed', () => {
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
