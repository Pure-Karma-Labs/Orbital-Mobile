/**
 * Tests for JoinOrbitScreen — invite code entry, auto-formatting, join submission, and error handling.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { JoinOrbitScreen } from '../JoinOrbitScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/conversationService', () => ({
  joinOrbit: jest.fn(),
}));

jest.mock('../../services/crypto/inviteCrypto', () => ({
  stripInviteCode: jest.fn((s: string) => s.replace(/-/g, '').toUpperCase()),
  formatInviteCode: jest.fn((s: string) => s.match(/.{1,4}/g)?.join('-') ?? s),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { joinOrbit } from '../../services/conversationService';
const mockJoinOrbit = joinOrbit as jest.Mock;

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
  key: 'JoinOrbit',
  name: 'JoinOrbit' as const,
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
          React.createElement(JoinOrbitScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof JoinOrbitScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof JoinOrbitScreen>['route'],
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

describe('JoinOrbitScreen — rendering', () => {
  it('renders the form with invite code input and join button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'join-orbit-screen')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'invite-code-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'join-orbit-button')).not.toThrow();
  });
});

describe('JoinOrbitScreen — validation', () => {
  it('join button is disabled when code is empty', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'join-orbit-button');
    expect(button.props.disabled).toBe(true);
  });

  it('join button is enabled when code has non-whitespace content', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABC123');
    });
    expect(findByTestId(renderer.root, 'join-orbit-button').props.disabled).toBe(false);
  });
});

describe('JoinOrbitScreen — auto-formatting', () => {
  it('auto-formats input with dashes every 4 chars', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCD1234');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABCD-1234');
  });

  it('handles paste of 20-char code', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCDEFGHJKMNPQRSTVW0');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABCD-EFGH-JKMN-PQRS-TVW0');
  });

  it('accepts v1 8-char codes', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABC12345');
    });
    const input = findByTestId(renderer.root, 'invite-code-input');
    expect(input.props.value).toBe('ABC1-2345');
  });
});

describe('JoinOrbitScreen — submission', () => {
  it('strips dashes before calling joinOrbit', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('ABCD1234EFGH5678JKMN');
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    // joinOrbit should receive the stripped code (no dashes)
    expect(mockJoinOrbit).toHaveBeenCalledWith('ABCD1234EFGH5678JKMN');
  });

  it('calls navigation.goBack() on successful join', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('VALID1');
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('JoinOrbitScreen — error handling', () => {
  it('shows error message on invalid or expired invite code', async () => {
    mockJoinOrbit.mockRejectedValue(new Error('Not found'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('BADCODE');
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('invalid'),
    );
    expect(errorText).toBeDefined();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });
});

describe('JoinOrbitScreen — loading state', () => {
  it('calls joinOrbit once and navigates on resolution', async () => {
    mockJoinOrbit.mockResolvedValue({ groupId: 'g-1', name: 'Family Orbit' });
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'invite-code-input').props.onChangeText('CODE99');
    });

    await act(async () => {
      findByTestId(renderer.root, 'join-orbit-button').props.onPress();
    });

    expect(mockJoinOrbit).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});
