/**
 * Tests for SettingsScreen — rendering, user info display, logout button.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { SettingsScreen } from '../SettingsScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/authService', () => ({
  logout: jest.fn(),
}));

jest.mock('../../stores', () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from '../../stores';
import { logout } from '../../services/authService';

const mockUseAuth = useAuth as jest.Mock;
const mockLogout = logout as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSettingsScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(SettingsScreen, null),
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
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
  });
  mockLogout.mockResolvedValue(undefined);
});

describe('SettingsScreen — rendering', () => {
  it('renders "Settings" text', () => {
    const renderer = renderSettingsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const settingsText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Settings',
    );
    expect(settingsText).toBeDefined();
  });

  it('renders the logout button', () => {
    const renderer = renderSettingsScreen();
    expect(() => findByTestId(renderer.root, 'logout-button')).not.toThrow();
  });

  it('has testID "settings-screen"', () => {
    const renderer = renderSettingsScreen();
    const found = renderer.root.findAll((node) => node.props.testID === 'settings-screen');
    expect(found.length).toBeGreaterThan(0);
  });

  it('shows displayName when available', () => {
    const renderer = renderSettingsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const nameText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Alice',
    );
    expect(nameText).toBeDefined();
  });

  it('falls back to username when displayName is null', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      userId: 'user-1',
      username: 'alice',
      displayName: null,
      avatarPath: null,
    });
    const renderer = renderSettingsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const nameText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'alice',
    );
    expect(nameText).toBeDefined();
  });
});

describe('SettingsScreen — logout', () => {
  it('calls logout when the logout button is pressed', async () => {
    const renderer = renderSettingsScreen();
    const button = findByTestId(renderer.root, 'logout-button');

    await act(async () => {
      button.props.onPress();
    });

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
