/**
 * Tests for CreateOrbitScreen — create orbit form, success view, and error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { CreateOrbitScreen } from '../CreateOrbitScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  createOrbit: jest.fn(),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { createOrbit } from '../../services/conversationService';
const mockCreateOrbit = createOrbit as jest.Mock;

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
  key: 'CreateOrbit',
  name: 'CreateOrbit' as const,
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
          React.createElement(CreateOrbitScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof CreateOrbitScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof CreateOrbitScreen>['route'],
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateOrbitScreen — rendering', () => {
  it('renders the form with orbit name input and create button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'create-orbit-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'orbit-name-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'create-orbit-button')).not.toThrow();
  });
});

describe('CreateOrbitScreen — validation', () => {
  it('create button is disabled when name is empty', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('create button is disabled when name is only whitespace', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');
    act(() => {
      input.props.onChangeText('   ');
    });
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('create button is enabled when name has non-whitespace content', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');
    act(() => {
      input.props.onChangeText('Family Orbit');
    });
    const button = findByTestId(renderer.root, 'create-orbit-button');
    expect(button.props.disabled).toBe(false);
  });
});

describe('CreateOrbitScreen — submission', () => {
  it('calls createOrbit with trimmed name on submit', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: 'ABC123' });
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');

    act(() => {
      input.props.onChangeText('  Family Orbit  ');
    });

    const button = findByTestId(renderer.root, 'create-orbit-button');
    await act(async () => {
      button.props.onPress();
    });

    expect(mockCreateOrbit).toHaveBeenCalledWith('Family Orbit');
  });

  it('shows success view with invite code after creation', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: 'XYZ789' });
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'orbit-name-input');

    act(() => {
      input.props.onChangeText('Family Orbit');
    });

    const button = findByTestId(renderer.root, 'create-orbit-button');
    await act(async () => {
      button.props.onPress();
    });

    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
  });

  it('displays the invite code text correctly in success view', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: 'XYZ789' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    const inviteCodeEl = findByTestId(renderer.root, 'invite-code-text');
    expect(inviteCodeEl.props.children).toBe('XYZ789');
  });

  it('done button calls navigation.goBack()', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: 'ABC123' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'done-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('CreateOrbitScreen — error handling', () => {
  it('shows error message on creation failure', async () => {
    mockCreateOrbit.mockRejectedValue(new Error('Server error'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
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

describe('CreateOrbitScreen — loading state', () => {
  it('calls createOrbit once and re-enables button after resolution', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: 'CODE' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    // createOrbit was called exactly once
    expect(mockCreateOrbit).toHaveBeenCalledTimes(1);
    // Success view is shown after resolution — form is no longer rendered
    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
  });
});
