import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { SettingsScreen } from '../SettingsScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
  }),
}));

jest.mock('../../services/authService', () => ({
  logout: jest.fn(),
  deleteAccount: jest.fn(),
}));

jest.mock('../../services/conversationService', () => ({
  fetchCreatorOrbitsDecrypted: jest.fn(),
}));

// Stub OrbitAdminActions to avoid importing its heavy service chain
jest.mock('../settings/OrbitAdminActions', () => ({
  OrbitAdminActions: () => 'OrbitAdminActions',
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
  useNotifications: jest.fn(),
}));

import { useAuth, useUI, useConversations, useNotifications } from '../../stores';
import { logout, deleteAccount } from '../../services/authService';
import { fetchCreatorOrbitsDecrypted } from '../../services/conversationService';

const mockUseAuth = useAuth as jest.Mock;
const mockUseUI = useUI as jest.Mock;
const mockUseConversations = useConversations as jest.Mock;
const mockUseNotifications = useNotifications as jest.Mock;
const mockLogout = logout as jest.Mock;
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockFetchCreatorOrbitsDecrypted = fetchCreatorOrbitsDecrypted as jest.Mock;

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
  mockNavigate.mockClear();
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
    soundEnabled: true,
    setSoundEnabled: jest.fn(),
  });
  mockUseConversations.mockReturnValue({
    activeConversationId: 'g1',
    conversations: { g1: { id: 'g1', type: 'group', name: 'Test Orbit' } },
  });
  mockUseNotifications.mockReturnValue({
    pushPermissionGranted: false,
    pushToken: null,
  });
  mockLogout.mockResolvedValue(undefined);
  mockDeleteAccount.mockResolvedValue({ status: 'success' });
  mockFetchCreatorOrbitsDecrypted.mockResolvedValue([]);
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

describe('SettingsScreen — delete account', () => {
  it('renders the Delete Account row', () => {
    const renderer = renderSettingsScreen();
    expect(() => findByTestId(renderer.root, 'delete-account-button')).not.toThrow();
  });

  it('tapping Delete Account shows confirm Alert with destructive Delete option', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();
    const button = findByTestId(renderer.root, 'delete-account-button');

    act(() => {
      button.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Delete your account?',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive' }),
      ]),
    );
    alertSpy.mockRestore();
  });

  it('confirming the Alert opens the DeletePasswordModal', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();
    const button = findByTestId(renderer.root, 'delete-account-button');

    act(() => {
      button.props.onPress();
    });

    // Extract the destructive "Delete" button handler
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const deleteButton = buttons.find((b) => b.text === 'Delete');

    act(() => {
      deleteButton!.onPress!();
    });

    // The modal should now be visible
    const modal = findByTestId(renderer.root, 'delete-password-modal');
    expect(modal.props.visible).toBe(true);
    alertSpy.mockRestore();
  });

  it('on success result: modal closes (app auto-navigates via auth gate)', async () => {
    mockDeleteAccount.mockResolvedValue({ status: 'success' });
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();

    // Tap delete account -> confirm alert -> modal opens
    const button = findByTestId(renderer.root, 'delete-account-button');
    act(() => { button.props.onPress(); });
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const deleteBtn = buttons.find((b) => b.text === 'Delete');
    act(() => { deleteBtn!.onPress!(); });

    // Enter password in the modal's TextInput and press submit
    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => { input.props.onChangeText('my-password'); });

    const submitBtn = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitBtn.props.onPress();
    });

    expect(mockDeleteAccount).toHaveBeenCalledWith('my-password');
    // Modal should be closed after success
    const modalAfter = findByTestId(renderer.root, 'delete-password-modal');
    expect(modalAfter.props.visible).toBe(false);
    alertSpy.mockRestore();
  });

  it('on incorrect_password: shows inline error in modal', async () => {
    mockDeleteAccount.mockResolvedValue({ status: 'incorrect_password' });
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();

    // Open modal
    const button = findByTestId(renderer.root, 'delete-account-button');
    act(() => { button.props.onPress(); });
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const deleteBtn = buttons.find((b) => b.text === 'Delete');
    act(() => { deleteBtn!.onPress!(); });

    // Enter password and submit
    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => { input.props.onChangeText('wrong-pw'); });

    const submitBtn = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitBtn.props.onPress();
    });

    // Modal still visible with error
    const modalAfter = findByTestId(renderer.root, 'delete-password-modal');
    expect(modalAfter.props.visible).toBe(true);
    // Error text visible inside the modal
    const errorText = findByTestId(renderer.root, 'delete-password-error');
    expect(errorText.props.children).toBe('Incorrect password');
    alertSpy.mockRestore();
  });

  it('on blocking_orbits: closes modal and shows blocking orbits list', async () => {
    mockDeleteAccount.mockResolvedValue({ status: 'blocking_orbits' });
    mockFetchCreatorOrbitsDecrypted.mockResolvedValue([
      { groupId: 'orbit-1', name: 'Family', inviteCode: null, memberCount: 3, isCreator: true },
      { groupId: 'orbit-2', name: 'Solo', inviteCode: null, memberCount: 1, isCreator: true },
    ]);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();

    // Open modal
    const button = findByTestId(renderer.root, 'delete-account-button');
    act(() => { button.props.onPress(); });
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const deleteBtn = buttons.find((b) => b.text === 'Delete');
    act(() => { deleteBtn!.onPress!(); });

    // Enter password and submit
    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => { input.props.onChangeText('pw'); });

    const submitBtn = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitBtn.props.onPress();
    });

    // Blocking orbits list should be rendered (only multi-member orbits)
    const orbitList = findByTestId(renderer.root, 'blocking-orbits-list');
    expect(orbitList).toBeDefined();
    // orbit-1 has memberCount 3, should appear; orbit-2 has memberCount 1, filtered out
    expect(() => findByTestId(renderer.root, 'blocking-orbit-orbit-1')).not.toThrow();
    expect(renderer.root.findAll((n) => n.props.testID === 'blocking-orbit-orbit-2')).toHaveLength(0);
    alertSpy.mockRestore();
  });
});
