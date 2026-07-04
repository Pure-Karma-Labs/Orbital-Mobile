/**
 * Tests for TermsAcceptanceScreen — checkbox gate, accept flow, error handling, logout.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { TermsAcceptanceScreen } from '../TermsAcceptanceScreen';
import { AuthError, NetworkError } from '../../services/api/errors';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

jest.mock('../../services/authService', () => ({
  acceptCurrentTerms: jest.fn(),
  logout: jest.fn(),
}));

jest.mock('../../components/OrbitalLoader', () => ({
  OrbitalLoader: () => null,
}));

import { acceptCurrentTerms, logout } from '../../services/authService';
const mockAcceptCurrentTerms = acceptCurrentTerms as jest.Mock;
const mockLogout = logout as jest.Mock;

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
        React.createElement(TermsAcceptanceScreen),
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

describe('TermsAcceptanceScreen — rendering', () => {
  it('renders the terms checkbox unchecked', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'gate-terms-checkbox')).not.toThrow();
    const checkbox = findCheckbox(renderer.root);
    expect(checkbox.props.accessibilityState.checked).toBe(false);
  });

  it('renders the accept button disabled initially', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'terms-gate-accept-button');
    expect(button.props.disabled).toBe(true);
  });

  it('renders the logout link', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'terms-gate-logout')).not.toThrow();
  });
});

describe('TermsAcceptanceScreen — checkbox enables accept', () => {
  it('accept button is enabled after checking the checkbox', () => {
    const renderer = renderScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    const button = findByTestId(renderer.root, 'terms-gate-accept-button');
    expect(button.props.disabled).toBeFalsy();
  });
});

describe('TermsAcceptanceScreen — accept flow', () => {
  it('calls acceptCurrentTerms on accept button press', async () => {
    mockAcceptCurrentTerms.mockResolvedValue(undefined);
    const renderer = renderScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'terms-gate-accept-button').props.onPress();
    });

    expect(mockAcceptCurrentTerms).toHaveBeenCalled();
  });

  it('shows error banner on generic rejection and re-enables button', async () => {
    mockAcceptCurrentTerms.mockRejectedValue(new Error('something broke'));
    const renderer = renderScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'terms-gate-accept-button').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('try again'),
    );
    expect(errorText).toBeDefined();

    // Button should be re-enabled (not stuck in loading)
    const button = findByTestId(renderer.root, 'terms-gate-accept-button');
    expect(button.props.disabled).toBeFalsy();
  });

  it('shows connection-specific error on NetworkError', async () => {
    mockAcceptCurrentTerms.mockRejectedValue(new NetworkError('offline'));
    const renderer = renderScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'terms-gate-accept-button').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('connection'),
    );
    expect(errorText).toBeDefined();
  });
});

describe('TermsAcceptanceScreen — AuthError auto-logout', () => {
  it('triggers logout on AuthError instead of showing error banner', async () => {
    mockAcceptCurrentTerms.mockRejectedValue(new AuthError(401, 'token expired'));
    mockLogout.mockResolvedValue(undefined);
    const renderer = renderScreen();

    act(() => {
      findCheckbox(renderer.root).props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'terms-gate-accept-button').props.onPress();
    });

    expect(mockLogout).toHaveBeenCalled();

    // No error banner should be visible — logout handles it
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('try again'),
    );
    expect(errorText).toBeUndefined();
  });
});

describe('TermsAcceptanceScreen — logout', () => {
  it('calls logout when logout link is pressed', async () => {
    mockLogout.mockResolvedValue(undefined);
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'terms-gate-logout').props.onPress();
    });

    expect(mockLogout).toHaveBeenCalled();
  });
});
