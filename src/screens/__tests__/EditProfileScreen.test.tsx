/**
 * Tests for EditProfileScreen — rendering, validation, and save flow.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { EditProfileScreen } from '../EditProfileScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

jest.mock('../../services/profileService', () => ({
  updateUserDisplayName: jest.fn(),
  updateUserAvatar: jest.fn(),
  removeUserAvatar: jest.fn(),
}));

jest.mock('../../stores', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { useAuth } from '../../stores';
import { updateUserDisplayName, updateUserAvatar } from '../../services/profileService';

const mockUseAuth = useAuth as jest.Mock;
const mockUpdateDisplayName = updateUserDisplayName as jest.Mock;
// @ts-expect-error — kept for future avatar upload tests
const _mockUpdateAvatar = updateUserAvatar as jest.Mock;

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
  key: 'EditProfile',
  name: 'EditProfile' as const,
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
          React.createElement(EditProfileScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof EditProfileScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof EditProfileScreen>['route'],
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
    updateProfile: jest.fn(),
  });
  mockUpdateDisplayName.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditProfileScreen — rendering', () => {
  it('renders the screen with testID', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'edit-profile-screen')).not.toThrow();
  });

  it('renders the display name input pre-populated', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    expect(input.props.value).toBe('Alice');
  });

  it('renders the username display', () => {
    const renderer = renderScreen();
    const usernameEl = findByTestId(renderer.root, 'username-display');
    expect(usernameEl.props.children).toEqual(['@', 'alice']);
  });

  it('renders the save button disabled initially (no changes)', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(true);
  });

  it('renders the character counter', () => {
    const renderer = renderScreen();
    const counter = findByTestId(renderer.root, 'char-counter');
    expect(counter.props.children).toEqual([5, '/', 15]);
  });
});

describe('EditProfileScreen — validation', () => {
  it('enables save when name changes to valid text', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('Bob');
    });
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(false);
  });

  it('keeps save disabled when name is empty', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('');
    });
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(true);
  });

  it('rejects invalid characters (special chars are not applied)', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('Alice!@#');
    });
    // The onChangeText handler should not update state with invalid chars
    // so value should remain 'Alice' (original)
    const inputAfter = findByTestId(renderer.root, 'display-name-input');
    expect(inputAfter.props.value).toBe('Alice');
  });
});

describe('EditProfileScreen — save flow', () => {
  it('calls updateUserDisplayName and goBack on successful save', async () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');

    act(() => {
      input.props.onChangeText('Bob');
    });

    const button = findByTestId(renderer.root, 'save-button');
    await act(async () => {
      button.props.onPress();
    });

    expect(mockUpdateDisplayName).toHaveBeenCalledWith('Bob');
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });

  it('shows error on API failure', async () => {
    mockUpdateDisplayName.mockRejectedValue(new Error('Server error'));
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');

    act(() => {
      input.props.onChangeText('Bob');
    });

    const button = findByTestId(renderer.root, 'save-button');
    await act(async () => {
      button.props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Server error',
    );
    expect(errorText).toBeDefined();
  });
});

describe('EditProfileScreen — avatar', () => {
  it('renders the avatar button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'avatar-button')).not.toThrow();
  });
});
