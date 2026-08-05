/**
 * Tests for PushNotificationSettingsScreen (#449).
 *
 * The store is mocked with a REAL (tiny) zustand store rather than a static
 * object so the optimistic-write-then-rollback path in notificationSettingsSync
 * actually re-renders the screen — that is the behaviour under test. Only the
 * HTTP layer (services/api/notificationSettings) is faked.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { PushNotificationSettingsScreen } from '../settings/PushNotificationSettingsScreen';

// @sentry/react-native ships ESM that jest does not transform; the screen now
// reaches it transitively via notificationSettingsSync (#678).
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack }),
}));

// The screen only calls setPushEnabled (#683) — both master transitions and the
// OS-denied alert live in the service now. deregisterCurrentDevice and
// teardownPushRegistration stay mocked so the tests below can prove the screen
// never reaches for them directly (the #677 listener-ownership invariant).
jest.mock('../../services/notificationService', () => ({
  setPushEnabled: jest.fn().mockResolvedValue(undefined),
  deregisterCurrentDevice: jest.fn().mockResolvedValue(undefined),
  teardownPushRegistration: jest.fn(),
}));

jest.mock('../../services/api/notificationSettings', () => ({
  getNotificationPrefs: jest.fn(),
  getNotificationMutes: jest.fn(),
  updateNotificationPrefs: jest.fn(),
  muteTargetApi: jest.fn(),
  unmuteTargetApi: jest.fn(),
}));

// A real zustand store keeps the screen reactive to the optimistic writes that
// the (unmocked) notificationSettingsSync performs.
jest.mock('../../stores/useAppStore', () => {
  const { create: createStore } = require('zustand');
  interface MockState {
    pushPermissionGranted: boolean;
    pushToken: string | null;
    pushOptOut: boolean;
    notificationPrefs: Record<string, boolean>;
    mutedTargets: Record<string, string>;
    setPushPermission: (granted: boolean) => void;
    setPushToken: (token: string | null) => void;
    setPushOptOut: (value: boolean) => void;
    setNotificationPrefs: (prefs: Record<string, boolean>) => void;
  }
  const store = createStore((set: (fn: unknown) => void) => ({
    pushPermissionGranted: true,
    pushToken: null,
    pushOptOut: false,
    notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
    mutedTargets: {},
    setPushPermission: (granted: boolean) => set({ pushPermissionGranted: granted }),
    setPushToken: (token: string | null) => set({ pushToken: token }),
    setPushOptOut: (value: boolean) => set({ pushOptOut: value }),
    setNotificationPrefs: (prefs: Record<string, boolean>) =>
      set((s: MockState) => ({ notificationPrefs: { ...s.notificationPrefs, ...prefs } })),
  }));
  return { useAppStore: store };
});

import { useAppStore } from '../../stores/useAppStore';
import {
  setPushEnabled,
  deregisterCurrentDevice,
  teardownPushRegistration,
} from '../../services/notificationService';
import { updateNotificationPrefs } from '../../services/api/notificationSettings';
import { NetworkError } from '../../services/api/errors';

const mockSetPushEnabled = setPushEnabled as jest.Mock;
const mockDeregister = deregisterCurrentDevice as jest.Mock;
const mockTeardown = teardownPushRegistration as jest.Mock;
const mockUpdatePrefs = updateNotificationPrefs as jest.Mock;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-local handle on the mock store
const store = useAppStore as unknown as any;

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(PushNotificationSettingsScreen, null),
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

/**
 * The pressable inside a SettingsRow.
 *
 * findByTestId returns the outer SettingsRow element, whose `onPress` is the
 * raw handler this screen passed down. The disabled behaviour lives one level
 * in, on SettingsRow's own TouchableOpacity — which is where a real tap lands.
 */
function rowTouchable(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll(
    (node) => node.props.testID === testID && node.props.accessibilityState !== undefined,
  );
  if (found.length === 0) throw new Error(`No pressable with testID "${testID}"`);
  return found[0];
}

/** The security-alerts caption — the only free-standing sentence on the screen. */
function captionText(root: ReactTestInstance): string | undefined {
  const texts = root.findAllByType('Text' as unknown as React.ComponentType);
  return texts
    .map((t) => t.props.children)
    .find((c): c is string => typeof c === 'string' && c.includes('security alerts'));
}

/** SettingsRow renders its `value` as the second-to-last Text child. */
function rowValue(root: ReactTestInstance, testID: string): string | undefined {
  const row = findByTestId(root, testID);
  const texts = row.findAllByType('Text' as unknown as React.ComponentType);
  const values = texts
    .map((t) => t.props.children)
    .filter((c): c is string => typeof c === 'string');
  return values.find((v) => v === 'On' || v === 'Off');
}

beforeEach(() => {
  jest.clearAllMocks();
  store.setState({
    pushPermissionGranted: true,
    pushToken: null,
    pushOptOut: false,
    notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
    mutedTargets: {},
  });
  mockUpdatePrefs.mockResolvedValue({
    newThread: true,
    newReply: true,
    newDm: true,
    memberJoined: true,
  });
});

describe('PushNotificationSettingsScreen — rendering', () => {
  it('renders the screen with the master push row and all four per-type rows', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'push-notification-settings-screen')).not.toThrow();
    for (const id of [
      'push-row',
      'pref-new-thread-row',
      'pref-new-reply-row',
      'pref-new-dm-row',
      'pref-member-joined-row',
    ]) {
      expect(() => findByTestId(renderer.root, id)).not.toThrow();
    }
  });

  it('renders the push-on security-alert caption', () => {
    const renderer = renderScreen();
    expect(captionText(renderer.root)).toBe(
      'When push is on, security alerts are always delivered.',
    );
  });

  it('renders the opted-out caption variant when the master row reads Off (#683)', () => {
    act(() => { store.setState({ pushOptOut: true }); });
    const renderer = renderScreen();

    // Master off deregisters the device, so security alerts stop too — the
    // caption must not keep promising delivery the app cannot make.
    const caption = captionText(renderer.root);
    expect(caption).toContain('security alerts');
    expect(caption).not.toBe('When push is on, security alerts are always delivered.');
    expect(caption).toMatch(/not delivered|off/i);
  });

  it('reflects stored preference values as On/Off', () => {
    act(() => {
      store.setState({
        notificationPrefs: { newThread: true, newReply: false, newDm: true, memberJoined: false },
      });
    });
    const renderer = renderScreen();
    expect(rowValue(renderer.root, 'pref-new-thread-row')).toBe('On');
    expect(rowValue(renderer.root, 'pref-new-reply-row')).toBe('Off');
    expect(rowValue(renderer.root, 'pref-new-dm-row')).toBe('On');
    expect(rowValue(renderer.root, 'pref-member-joined-row')).toBe('Off');
  });
});

// The screen is now a pure intent surface (#683): every master transition —
// including the OS-denied alert — is owned by notificationService.setPushEnabled
// and pinned in notificationService.test.ts. What is pinned HERE is which
// direction the tap asks for, which is decided by the derived pushEnabled
// predicate the row also renders from.
describe('PushNotificationSettingsScreen — master push toggle', () => {
  it('tapping push row when OFF asks the service to turn push ON', async () => {
    act(() => { store.setState({ pushPermissionGranted: false }); });
    const renderer = renderScreen();

    await act(async () => {
      await findByTestId(renderer.root, 'push-row').props.onPress();
    });

    expect(mockSetPushEnabled).toHaveBeenCalledTimes(1);
    expect(mockSetPushEnabled).toHaveBeenCalledWith(true);
  });

  it('tapping push row when ON asks the service to turn push OFF', async () => {
    const renderer = renderScreen();

    await act(async () => {
      await findByTestId(renderer.root, 'push-row').props.onPress();
    });

    expect(mockSetPushEnabled).toHaveBeenCalledTimes(1);
    expect(mockSetPushEnabled).toHaveBeenCalledWith(false);
    // Transition mechanics belong to the service, never to this screen.
    expect(mockDeregister).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('renders Off and runs the ON branch after a restart-restored opt-out (#683)', async () => {
    // The restart state the issue is about: OS permission is still granted
    // (it is re-derived at launch) but the user opted out. Display and branch
    // both read the derived predicate, so they cannot disagree.
    act(() => { store.setState({ pushOptOut: true, pushPermissionGranted: true }); });
    const renderer = renderScreen();

    expect(rowValue(renderer.root, 'push-row')).toBe('Off');

    await act(async () => {
      await findByTestId(renderer.root, 'push-row').props.onPress();
    });

    expect(mockSetPushEnabled).toHaveBeenCalledWith(true);
  });

  it('dims the per-type rows for a restart-restored opt-out, not just for a permission denial', () => {
    act(() => { store.setState({ pushOptOut: true, pushPermissionGranted: true }); });
    const renderer = renderScreen();

    for (const id of ['pref-new-thread-row', 'pref-new-dm-row']) {
      expect(findByTestId(renderer.root, id).props.disabled).toBe(true);
    }
  });

  it('unmounting the screen never tears down push registration (#677 blocking finding)', async () => {
    // Enable push on this screen, then navigate Back. The token-refresh
    // listener and any registration retry must survive the unmount — the
    // service owns that lifetime, not this screen.
    act(() => { store.setState({ pushPermissionGranted: false }); });
    const renderer = renderScreen();

    await act(async () => {
      await findByTestId(renderer.root, 'push-row').props.onPress();
    });
    expect(mockSetPushEnabled).toHaveBeenCalledTimes(1);

    act(() => { renderer.unmount(); });

    expect(mockTeardown).not.toHaveBeenCalled();
    expect(mockDeregister).not.toHaveBeenCalled();
  });
});

describe('PushNotificationSettingsScreen — per-type toggles', () => {
  it('tapping a per-type row PUTs that key and flips the rendered value', async () => {
    mockUpdatePrefs.mockResolvedValue({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
    const renderer = renderScreen();
    expect(rowValue(renderer.root, 'pref-new-reply-row')).toBe('On');

    await act(async () => {
      findByTestId(renderer.root, 'pref-new-reply-row').props.onPress();
    });

    expect(mockUpdatePrefs).toHaveBeenCalledWith({ newReply: false });
    expect(store.getState().notificationPrefs.newReply).toBe(false);
    expect(rowValue(renderer.root, 'pref-new-reply-row')).toBe('Off');
  });

  it('maps each row to its own preference key', async () => {
    const renderer = renderScreen();

    for (const [testID, key] of [
      ['pref-new-thread-row', 'newThread'],
      ['pref-new-reply-row', 'newReply'],
      ['pref-new-dm-row', 'newDm'],
      ['pref-member-joined-row', 'memberJoined'],
    ] as const) {
      mockUpdatePrefs.mockClear();
      await act(async () => {
        findByTestId(renderer.root, testID).props.onPress();
      });
      expect(mockUpdatePrefs).toHaveBeenCalledWith({ [key]: false });
    }
  });

  it('rolls the row back when the PUT rejects', async () => {
    mockUpdatePrefs.mockRejectedValue(new NetworkError('offline'));
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'pref-new-dm-row').props.onPress();
    });

    // Optimistic flip was reverted — the row reads On again
    expect(store.getState().notificationPrefs.newDm).toBe(true);
    expect(rowValue(renderer.root, 'pref-new-dm-row')).toBe('On');
  });

  it('does not raise an Alert when the failure is plain connectivity', async () => {
    mockUpdatePrefs.mockRejectedValue(new NetworkError('offline'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = renderScreen();

    await act(async () => {
      findByTestId(renderer.root, 'pref-new-dm-row').props.onPress();
    });

    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

describe('PushNotificationSettingsScreen — per-type rows disabled when master push is off', () => {
  it('marks every per-type row disabled and non-pressable', () => {
    act(() => { store.setState({ pushPermissionGranted: false }); });
    const renderer = renderScreen();

    for (const id of [
      'pref-new-thread-row',
      'pref-new-reply-row',
      'pref-new-dm-row',
      'pref-member-joined-row',
    ]) {
      expect(findByTestId(renderer.root, id).props.disabled).toBe(true);
      const pressable = rowTouchable(renderer.root, id);
      expect(pressable.props.disabled).toBe(true);
      expect(pressable.props.accessibilityState).toEqual({ disabled: true });
    }
  });

  it('a disabled row does not write a preference', async () => {
    act(() => { store.setState({ pushPermissionGranted: false }); });
    const renderer = renderScreen();

    await act(async () => {
      rowTouchable(renderer.root, 'pref-new-thread-row').props.onPress();
    });

    expect(mockUpdatePrefs).not.toHaveBeenCalled();
    expect(store.getState().notificationPrefs.newThread).toBe(true);
  });

  it('re-enables the rows once push is on', async () => {
    const renderer = renderScreen();
    expect(findByTestId(renderer.root, 'pref-new-thread-row').props.disabled).toBe(false);
    expect(rowTouchable(renderer.root, 'pref-new-thread-row').props.disabled).toBe(false);

    await act(async () => {
      rowTouchable(renderer.root, 'pref-new-thread-row').props.onPress();
    });

    expect(mockUpdatePrefs).toHaveBeenCalledWith({ newThread: false });
  });
});
