/**
 * Tests for CreateOrbitScreen — create orbit form, two-phase success view, and error handling.
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
  createInviteCode: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { createOrbit, createInviteCode } from '../../services/conversationService';
const mockCreateOrbit = createOrbit as jest.Mock;
const mockCreateInviteCode = createInviteCode as jest.Mock;

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
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
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

  it('shows Phase 1 success view with email input after creation', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-email-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'generate-invite-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'skip-button')).not.toThrow();
  });

  it('skip button calls navigation.goBack()', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'skip-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('CreateOrbitScreen — invite generation', () => {
  it('generates v2 invite code and shows formatted code', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
    mockCreateInviteCode.mockResolvedValue('ABCD1234EFGH5678JKMN');

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('Family Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    // Phase 1 — enter email
    const emailInput = findByTestId(renderer.root, 'invite-email-input');
    act(() => {
      emailInput.props.onChangeText('member@example.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
    });

    expect(mockCreateInviteCode).toHaveBeenCalledWith('g-1', 'member@example.com');

    // Phase 2 — formatted code shown
    const codeText = findByTestId(renderer.root, 'invite-code-text');
    expect(codeText.props.children).toBe('ABCD-1234-EFGH-5678-JKMN');

    // Warning text visible
    expect(() => findByTestId(renderer.root, 'code-warning')).not.toThrow();

    // Share and Done buttons visible
    expect(() => findByTestId(renderer.root, 'share-invite-button')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'done-button')).not.toThrow();
  });

  it('done button calls navigation.goBack() from Phase 2', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
    mockCreateInviteCode.mockResolvedValue('ABCD1234EFGH5678JKMN');

    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'invite-email-input').props.onChangeText('test@test.com');
    });

    await act(async () => {
      findByTestId(renderer.root, 'generate-invite-button').props.onPress();
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
  it('calls createOrbit once and shows success view after resolution', async () => {
    mockCreateOrbit.mockResolvedValue({ groupId: 'g-1', inviteCode: null });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'orbit-name-input').props.onChangeText('My Orbit');
    });

    await act(async () => {
      findByTestId(renderer.root, 'create-orbit-button').props.onPress();
    });

    expect(mockCreateOrbit).toHaveBeenCalledTimes(1);
    expect(() => findByTestId(renderer.root, 'create-orbit-success')).not.toThrow();
  });
});
