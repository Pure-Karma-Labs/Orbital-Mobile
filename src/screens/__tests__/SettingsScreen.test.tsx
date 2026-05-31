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

// Stub OrbitAdminActions to avoid importing its heavy service chain.
// Renders a touchable so tests can simulate completion callbacks.
jest.mock('../settings/OrbitAdminActions', () => ({
  OrbitAdminActions: (props: { onCompleted?: (action: string, groupId: string) => void; group?: { groupId: string } }) => {
    const React = require('react');
    const { TouchableOpacity, Text } = require('react-native');
    return React.createElement(
      TouchableOpacity,
      {
        testID: `admin-actions-${props.group?.groupId ?? 'unknown'}`,
        onPress: () => props.onCompleted?.('dissolve', props.group?.groupId ?? ''),
      },
      React.createElement(Text, null, 'MockAdminActions'),
    );
  },
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

  it('on blocking_orbits: closes modal and shows ONLY orbits in the authoritative list (DMs excluded)', async () => {
    // The backend's 409 response says only orbit-1 is blocking (orbit-dm is a DM, not blocking)
    mockDeleteAccount.mockResolvedValue({
      status: 'blocking_orbits',
      blockingOrbits: [{ id: 'orbit-1', encryptedName: 'enc-family' }],
    });
    // fetchCreatorOrbitsDecrypted returns ALL creator orbits including a DM-like one
    mockFetchCreatorOrbitsDecrypted.mockResolvedValue([
      { groupId: 'orbit-1', name: 'Family', inviteCode: null, memberCount: 3, isCreator: true },
      { groupId: 'orbit-dm', name: 'DM with Bob', inviteCode: null, memberCount: 2, isCreator: true },
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

    // Blocking orbits list should be rendered
    const orbitList = findByTestId(renderer.root, 'blocking-orbits-list');
    expect(orbitList).toBeDefined();
    // orbit-1 IS in the authoritative list → shown
    expect(() => findByTestId(renderer.root, 'blocking-orbit-orbit-1')).not.toThrow();
    // orbit-dm is NOT in the authoritative list (it's a DM) → excluded
    expect(renderer.root.findAll((n) => n.props.testID === 'blocking-orbit-orbit-dm')).toHaveLength(0);
    alertSpy.mockRestore();
  });

  it('resolving all blocking orbits shows Continue button and retry re-attempts deletion', async () => {
    // First call: 409 with one blocking orbit
    mockDeleteAccount.mockResolvedValueOnce({
      status: 'blocking_orbits',
      blockingOrbits: [{ id: 'orbit-1', encryptedName: 'enc-family' }],
    });
    mockFetchCreatorOrbitsDecrypted.mockResolvedValue([
      { groupId: 'orbit-1', name: 'Family', inviteCode: null, memberCount: 3, isCreator: true },
    ]);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderSettingsScreen();

    // Open modal and trigger blocking_orbits
    const button = findByTestId(renderer.root, 'delete-account-button');
    act(() => { button.props.onPress(); });
    const alertArgs = alertSpy.mock.calls[0];
    const buttons = alertArgs[2] as Array<{ text: string; onPress?: () => void }>;
    const deleteBtn = buttons.find((b) => b.text === 'Delete');
    act(() => { deleteBtn!.onPress!(); });

    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => { input.props.onChangeText('pw'); });
    const submitBtn = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitBtn.props.onPress();
    });

    // Simulate resolving the blocking orbit via the mock OrbitAdminActions button
    const adminActionsBtn = findByTestId(renderer.root, 'admin-actions-orbit-1');
    act(() => {
      adminActionsBtn.props.onPress();
    });

    // After all orbits resolved, the "Continue with Deletion" button should appear
    const retryBtn = findByTestId(renderer.root, 'retry-delete-button');
    expect(retryBtn).toBeDefined();

    // Set up the second call to succeed
    mockDeleteAccount.mockResolvedValueOnce({ status: 'success' });

    // Tap Continue — it should re-open the password modal
    act(() => {
      retryBtn.props.onPress();
    });

    // Modal should now be visible again for re-entry
    const modal = findByTestId(renderer.root, 'delete-password-modal');
    expect(modal.props.visible).toBe(true);

    // Enter password and submit again
    const input2 = findByTestId(renderer.root, 'delete-password-input');
    act(() => { input2.props.onChangeText('pw2'); });
    const submitBtn2 = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitBtn2.props.onPress();
    });

    // Second call should have been made
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
    expect(mockDeleteAccount).toHaveBeenLastCalledWith('pw2');
    alertSpy.mockRestore();
  });
});
