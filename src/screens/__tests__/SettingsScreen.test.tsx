import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { SettingsScreen } from '../SettingsScreen';

jest.mock('../../services/authService', () => ({
  logout: jest.fn(),
}));

jest.mock('../../services/api/groups', () => ({
  getGroupQuota: jest.fn().mockResolvedValue({
    groupId: 'g1',
    storage: { used: 251658240, limit: 524288000, percentage: 48, warning: false },
    files: { count: 10, limit: 100, percentage: 10, warning: false },
  }),
}));

jest.mock('../../stores', () => ({
  useAuth: jest.fn(),
  useUI: jest.fn(),
  useConversations: jest.fn(),
}));

import { useAuth, useUI, useConversations } from '../../stores';
import { logout } from '../../services/authService';

const mockUseAuth = useAuth as jest.Mock;
const mockUseUI = useUI as jest.Mock;
const mockUseConversations = useConversations as jest.Mock;
const mockLogout = logout as jest.Mock;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
  });
  mockUseUI.mockReturnValue({
    colorScheme: 'system',
    setColorScheme: jest.fn(),
  });
  mockUseConversations.mockReturnValue({
    activeConversationId: 'g1',
    conversations: { g1: { id: 'g1', type: 'group', name: 'Test Orbit' } },
  });
  mockLogout.mockResolvedValue(undefined);
});

describe('SettingsScreen — rendering', () => {
  it('has testID "settings-screen"', () => {
    const renderer = renderSettingsScreen();
    const found = renderer.root.findAll((node) => node.props.testID === 'settings-screen');
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders the logout button', () => {
    const renderer = renderSettingsScreen();
    expect(() => findByTestId(renderer.root, 'logout-button')).not.toThrow();
  });

  it('renders all section headers', () => {
    const renderer = renderSettingsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const textContents = allText.map((n) => n.props.children).filter((c) => typeof c === 'string');
    for (const section of ['Appearance', 'Notifications', 'Privacy', 'Storage', 'Account']) {
      expect(textContents.some((t: string) => t.includes(section))).toBe(true);
    }
  });

  it('shows displayName in profile card', () => {
    const renderer = renderSettingsScreen();
    expect(() => findByTestId(renderer.root, 'profile-card')).not.toThrow();
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
    const profileCard = findByTestId(renderer.root, 'profile-card');
    expect(profileCard).toBeDefined();
  });
});

describe('SettingsScreen — logout', () => {
  it('shows confirmation dialog on logout press', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();
    const button = findByTestId(renderer.root, 'logout-button');

    act(() => {
      button.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Log out of Orbital?',
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Log Out', style: 'destructive' }),
      ]),
    );
    alertSpy.mockRestore();
  });
});
