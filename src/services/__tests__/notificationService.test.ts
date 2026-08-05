/**
 * Tests for notificationService — push notification permission, foreground
 * display, tap handling, and device deregistration.
 *
 * Covers: registerIfEnabled (incl. the #683 opt-out gate), setPushEnabled,
 * setupForegroundHandler, setupNotificationTapHandler, deregisterCurrentDevice.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockRegisterDevice = jest.fn().mockResolvedValue({ success: true });
const mockDeregisterDevice = jest.fn().mockResolvedValue(undefined);

jest.mock('../api/devices', () => ({
  registerDevice: (...args: unknown[]) => mockRegisterDevice(...args),
  deregisterDevice: (...args: unknown[]) => mockDeregisterDevice(...args),
}));

jest.mock('../deviceId', () => ({
  getDeviceId: jest.fn(() => 'mock-device-id'),
}));

const mockSetPushPermission = jest.fn();
const mockSetPushToken = jest.fn();
const mockSetIdentityKeyConflict = jest.fn();
const mockSetConflictSource = jest.fn();
const mockSetPushOptOut = jest.fn();

/**
 * Mutable store double for the #449 suppression check. Reset in beforeEach;
 * individual tests mutate the halves they care about.
 */
const mockStoreState: {
  viewingConversationId: string | null;
  conversations: Record<string, { id: string; type: 'group' | 'direct' }>;
  notificationPrefs: Record<string, boolean>;
  mutedTargets: Record<string, string>;
  pushOptOut: boolean;
} = {
  viewingConversationId: null,
  conversations: {},
  notificationPrefs: { newThread: true, newReply: true, newDm: true, memberJoined: true },
  mutedTargets: {},
  pushOptOut: false,
};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setPushPermission: mockSetPushPermission,
      setPushToken: mockSetPushToken,
      setIdentityKeyConflict: mockSetIdentityKeyConflict,
      setConflictSource: mockSetConflictSource,
      viewingConversationId: mockStoreState.viewingConversationId,
      conversations: mockStoreState.conversations,
      notificationPrefs: mockStoreState.notificationPrefs,
      mutedTargets: mockStoreState.mutedTargets,
      pushOptOut: mockStoreState.pushOptOut,
      setPushOptOut: mockSetPushOptOut,
    })),
  },
}));

jest.mock('../../navigation/navigationRef', () => ({
  navigationRef: { isReady: jest.fn(() => false), navigate: jest.fn() },
  setPendingNotificationPayload: jest.fn(),
  setPayloadConsumer: jest.fn(),
}));

// #539: recoveryState is a dependency-free module notificationService reads
// directly (importing keyRecoveryService instead would create an import
// cycle via authService -> notificationService).
const mockIsRecoveryInitiator = jest.fn(() => false);
jest.mock('../recoveryState', () => ({
  isRecoveryInitiator: () => mockIsRecoveryInitiator(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Alert, PermissionsAndroid, Platform } from 'react-native';
import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import {
  registerIfEnabled,
  setPushEnabled,
  setupForegroundHandler,
  setupNotificationTapHandler,
  deregisterCurrentDevice,
  initNotifications,
  teardownPushRegistration,
} from '../notificationService';
import {
  navigationRef,
  setPendingNotificationPayload,
} from '../../navigation/navigationRef';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the messaging singleton from the mock. */
function getMessagingInstance() {
  return messaging();
}

/** Original Platform.OS/Version descriptors, restored after each Platform-mutating test. */
const originalPlatformOS = Platform.OS;
const originalPlatformVersionDescriptor = Object.getOwnPropertyDescriptor(Platform, 'Version');

/** Override Platform.OS and Platform.Version for a single test. Restore with restorePlatform(). */
function mockPlatform(os: 'android' | 'ios', version: number): void {
  (Platform as { OS: string }).OS = os;
  Object.defineProperty(Platform, 'Version', {
    value: version,
    configurable: true,
    writable: true,
  });
}

/** Restore Platform.OS/Version to their original (test-environment default) values. */
function restorePlatform(): void {
  (Platform as { OS: string }).OS = originalPlatformOS;
  if (originalPlatformVersionDescriptor) {
    Object.defineProperty(Platform, 'Version', originalPlatformVersionDescriptor);
  }
}

/** Build a minimal remoteMessage with the given data payload. */
function remoteMessage(
  data: Record<string, string>,
): FirebaseMessagingTypes.RemoteMessage {
  return { data } as FirebaseMessagingTypes.RemoteMessage;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Reset default mock returns
  (notifee.requestPermission as jest.Mock).mockResolvedValue({
    authorizationStatus: 1, // AUTHORIZED
  });
  (getMessagingInstance().getToken as jest.Mock).mockResolvedValue('mock-fcm-token');
  (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValue(jest.fn());
  (getMessagingInstance().onNotificationOpenedApp as jest.Mock).mockReturnValue(jest.fn());
  // mockReturnValue survives clearAllMocks — reset explicitly every test.
  mockIsRecoveryInitiator.mockReturnValue(false);
  // #449: reset the store double — prefs all on, nothing muted.
  mockStoreState.viewingConversationId = null;
  mockStoreState.conversations = {};
  mockStoreState.notificationPrefs = {
    newThread: true,
    newReply: true,
    newDm: true,
    memberJoined: true,
  };
  mockStoreState.mutedTargets = {};
  mockStoreState.pushOptOut = false;
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// registerIfEnabled — registration path
// ---------------------------------------------------------------------------

describe('registerIfEnabled — registration path', () => {
  it('sets pushPermission(false) and returns early when permission is denied', async () => {
    (notifee.requestPermission as jest.Mock).mockResolvedValueOnce({
      authorizationStatus: 0, // DENIED
    });

    await registerIfEnabled();

    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    expect(getMessagingInstance().getToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('gets token and registers device when permission is granted', async () => {
    await registerIfEnabled();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(getMessagingInstance().getToken).toHaveBeenCalled();
    expect(mockSetPushToken).toHaveBeenCalledWith('mock-fcm-token');
    expect(mockRegisterDevice).toHaveBeenCalledWith({
      platform: expect.stringMatching(/^(ios|android)$/),
      pushToken: 'mock-fcm-token',
      deviceId: 'mock-device-id',
    });
  });

  it('sets pushPermission(true) when provisional permission is granted', async () => {
    (notifee.requestPermission as jest.Mock).mockResolvedValueOnce({
      authorizationStatus: 2, // PROVISIONAL
    });

    await registerIfEnabled();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(mockRegisterDevice).toHaveBeenCalled();
  });

  it('retries registration after 5s when registerDevice throws', async () => {
    mockRegisterDevice
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ success: true });

    await registerIfEnabled();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    // First call failed
    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);

    // Advance timer to trigger retry
    jest.advanceTimersByTime(5000);
    // Let the async retry run
    await Promise.resolve();

    expect(mockRegisterDevice).toHaveBeenCalledTimes(2);
  });

  it('does not propagate error when both initial and retry registration fail', async () => {
    mockRegisterDevice
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Still failing'));

    // Should not throw
    await registerIfEnabled();

    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    // Both calls made, no error propagated
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2);
  });

  it('teardownPushRegistration unsubscribes the listener installed by registerIfEnabled', async () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValueOnce(mockUnsub);

    await registerIfEnabled();

    teardownPushRegistration();
    expect(mockUnsub).toHaveBeenCalled();
  });

  it('re-registration replaces the previous token-refresh listener (module ownership)', async () => {
    const firstUnsub = jest.fn();
    const secondUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock)
      .mockReturnValueOnce(firstUnsub)
      .mockReturnValueOnce(secondUnsub);

    await registerIfEnabled();
    expect(firstUnsub).not.toHaveBeenCalled();

    // Second registration must tear down the first listener itself —
    // no screen ever owns this lifetime (PR #677 review finding).
    await registerIfEnabled();
    expect(firstUnsub).toHaveBeenCalledTimes(1);
    expect(secondUnsub).not.toHaveBeenCalled();
  });

  it('teardownPushRegistration unsubscribes the current listener and is idempotent', async () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValueOnce(mockUnsub);

    await registerIfEnabled();
    teardownPushRegistration();
    expect(mockUnsub).toHaveBeenCalledTimes(1);
    teardownPushRegistration();
    expect(mockUnsub).toHaveBeenCalledTimes(1);
  });

  it('a second registration replaces the listener; teardown then tears down only the current one', async () => {
    const firstUnsub = jest.fn();
    const secondUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock)
      .mockReturnValueOnce(firstUnsub)
      .mockReturnValueOnce(secondUnsub);

    await registerIfEnabled();
    await registerIfEnabled(); // replaces; firstUnsub called once here
    expect(firstUnsub).toHaveBeenCalledTimes(1);

    teardownPushRegistration(); // logout path — tears down only the current listener
    expect(secondUnsub).toHaveBeenCalledTimes(1);
    expect(firstUnsub).toHaveBeenCalledTimes(1); // not called again
  });
});

// ---------------------------------------------------------------------------
// registerIfEnabled — Android 13+ POST_NOTIFICATIONS permission
// ---------------------------------------------------------------------------

describe('registerIfEnabled — Android 13+ POST_NOTIFICATIONS permission', () => {
  let requestSpy: jest.SpyInstance;

  afterEach(() => {
    requestSpy?.mockRestore();
    restorePlatform();
  });

  it('proceeds to Firebase requestPermission when POST_NOTIFICATIONS is granted (API 33+)', async () => {
    mockPlatform('android', 33);
    requestSpy = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);

    await registerIfEnabled();

    expect(requestSpy).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    expect(notifee.requestPermission).toHaveBeenCalled();
    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(mockRegisterDevice).toHaveBeenCalled();
  });

  it('returns early with setPushPermission(false) when POST_NOTIFICATIONS is denied (API 33+)', async () => {
    mockPlatform('android', 33);
    requestSpy = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);

    await registerIfEnabled();

    expect(requestSpy).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    // Should return early — Notifee/Firebase permission flow never runs.
    expect(notifee.requestPermission).not.toHaveBeenCalled();
    expect(getMessagingInstance().getToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('skips the POST_NOTIFICATIONS check entirely below API 33', async () => {
    mockPlatform('android', 32);
    requestSpy = jest.spyOn(PermissionsAndroid, 'request');

    await registerIfEnabled();

    expect(requestSpy).not.toHaveBeenCalled();
    // Falls through directly to the Notifee/Firebase flow.
    expect(notifee.requestPermission).toHaveBeenCalled();
    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
  });

  it('does not invoke PermissionsAndroid.request on iOS regardless of Platform.Version', async () => {
    mockPlatform('ios', 33);
    requestSpy = jest.spyOn(PermissionsAndroid, 'request');

    await registerIfEnabled();

    expect(requestSpy).not.toHaveBeenCalled();
    expect(notifee.requestPermission).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerIfEnabled — the opt-out gate (#683)
// ---------------------------------------------------------------------------

describe('registerIfEnabled — opt-out gate (#683)', () => {
  it('never registers when the user has opted out', async () => {
    mockStoreState.pushOptOut = true;

    await registerIfEnabled();

    // The bug this issue fixes: the launch path used to re-register
    // unconditionally, silently undoing an explicit master-push Off.
    expect(notifee.requestPermission).not.toHaveBeenCalled();
    expect(getMessagingInstance().getToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(getMessagingInstance().onTokenRefresh).not.toHaveBeenCalled();
  });

  it('RECONCILES by deregistering the device on every opted-out launch', async () => {
    mockStoreState.pushOptOut = true;

    await registerIfEnabled();

    // Deliberately NOT a no-op: the DELETE issued at toggle time can fail
    // (offline, 5xx), which would leave a live token server-side forever while
    // the UI reads Off. The backend DELETE is idempotent and un-rate-limited.
    expect(mockDeregisterDevice).toHaveBeenCalledTimes(1);
    expect(mockDeregisterDevice).toHaveBeenCalledWith('mock-device-id');
  });

  it('does not throw when the reconciling deregistration fails', async () => {
    mockStoreState.pushOptOut = true;
    mockDeregisterDevice.mockRejectedValueOnce(new Error('offline'));

    await expect(registerIfEnabled()).resolves.toBeUndefined();
  });

  it('registers and does not deregister when the user has not opted out', async () => {
    mockStoreState.pushOptOut = false;

    await registerIfEnabled();

    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
    expect(mockDeregisterDevice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setPushEnabled — master toggle transitions (#683)
// ---------------------------------------------------------------------------

describe('setPushEnabled(false) — turning push off', () => {
  it('writes intent, tears down the listener, deregisters, then clears OS state — in that order', async () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValueOnce(mockUnsub);
    // Install a listener first so teardown has something observable to do.
    await registerIfEnabled();
    mockSetPushPermission.mockClear();
    mockSetPushToken.mockClear();

    await setPushEnabled(false);

    expect(mockSetPushOptOut).toHaveBeenCalledWith(true);
    expect(mockUnsub).toHaveBeenCalledTimes(1);
    expect(mockDeregisterDevice).toHaveBeenCalledTimes(1);
    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    expect(mockSetPushToken).toHaveBeenCalledWith(null);

    // Ordering matters: intent is persisted BEFORE the network call, so a
    // deregistration that fails mid-flight still leaves an opt-out to reconcile
    // at the next launch.
    const intentAt = mockSetPushOptOut.mock.invocationCallOrder[0];
    const teardownAt = mockUnsub.mock.invocationCallOrder[0];
    const deregisterAt = mockDeregisterDevice.mock.invocationCallOrder[0];
    const clearPermissionAt = mockSetPushPermission.mock.invocationCallOrder[0];
    expect(intentAt).toBeLessThan(teardownAt);
    expect(teardownAt).toBeLessThan(deregisterAt);
    expect(deregisterAt).toBeLessThan(clearPermissionAt);
  });

  it('still clears OS state when the deregistration fails', async () => {
    mockDeregisterDevice.mockRejectedValueOnce(new Error('offline'));

    await setPushEnabled(false);

    expect(mockSetPushOptOut).toHaveBeenCalledWith(true);
    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    expect(mockSetPushToken).toHaveBeenCalledWith(null);
  });
});

describe('setPushEnabled(true) — turning push on', () => {
  it('clears the opt-out and registers', async () => {
    await setPushEnabled(true);

    expect(mockSetPushOptOut).toHaveBeenCalledWith(false);
    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
  });

  it('records the intent but does not register when the OS has denied notifications', async () => {
    (notifee.getNotificationSettings as jest.Mock).mockResolvedValueOnce({
      authorizationStatus: 0, // DENIED
      android: {},
      ios: {},
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await setPushEnabled(true);

    // A tap IS intent: the flag is cleared even though the OS refuses, so a
    // user who later grants permission in Settings converges at next launch
    // instead of being silently held at opted-out.
    expect(mockSetPushOptOut).toHaveBeenCalledWith(false);
    expect(mockSetPushOptOut).not.toHaveBeenCalledWith(true);
    expect(alertSpy).toHaveBeenCalledWith(
      'Notifications Disabled',
      'Push notifications were previously denied. Enable them in Settings.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Open Settings' }),
      ]),
    );
    expect(notifee.requestPermission).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// setupForegroundHandler
// ---------------------------------------------------------------------------

describe('setupForegroundHandler', () => {
  /** Capture the onMessage callback for simulating incoming messages. */
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  it('displays a notification for known type (new_thread)', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'new_thread', tid: 'thread-123' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New thread in an Orbit',
        body: 'Tap to view',
      }),
    );
  });

  it('displays correct title for new_reply type', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'new_reply', tid: 'thread-456' } });

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New reply in a thread',
      }),
    );
  });

  it('displays correct title for new_dm type', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'new_dm', gid: 'conv-789' } });

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New direct message',
      }),
    );
  });

  it('displays correct title for orbit_invite type', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'orbit_invite', code: 'INV-001' } });

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "You've been invited to an Orbit",
      }),
    );
  });

  it('displays correct title for member_joined type', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'member_joined', gid: 'group-123' } });

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'A new member joined your Orbit',
      }),
    );
  });

  it('does not display notification for unknown type', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'unknown_event_type' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('does not display notification when data is missing', async () => {
    const cb = getOnMessageCallback();
    await cb({});

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('does not display notification when type field is missing', async () => {
    const cb = getOnMessageCallback();
    await cb({ data: { tid: 'thread-123' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function', () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onMessage as jest.Mock).mockReturnValueOnce(mockUnsub);

    const unsubscribe = setupForegroundHandler();

    expect(unsubscribe).toBe(mockUnsub);
  });

  // -------------------------------------------------------------------------
  // #539: identity_key_reset — foreground arrival
  // -------------------------------------------------------------------------

  it('sets identityKeyConflict + conflictSource(push) and still displays the banner when not the recovery initiator', async () => {
    mockIsRecoveryInitiator.mockReturnValue(false);
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'identity_key_reset', v: '1' } });

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('push');
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Security alert' }),
    );
  });

  it('does not set identityKeyConflict when this device is the recovery initiator (self-push suppression)', async () => {
    mockIsRecoveryInitiator.mockReturnValue(true);
    const cb = getOnMessageCallback();
    await cb({ data: { t: 'identity_key_reset', v: '1' } });

    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalled();
    expect(mockSetConflictSource).not.toHaveBeenCalled();
    // Banner still displays — push is content-free, no reason to suppress it.
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Security alert' }),
    );
  });

  describe('when Notifee is unavailable', () => {
    // notifeeAvailable is module-private state shared across every test in
    // this file (one module instance per test file). Restore it to true
    // unconditionally in afterEach so a failed assertion above can't leave
    // notifeeAvailable=false and cascade-fail every later test in the file.
    afterEach(async () => {
      restorePlatform();
      (notifee.getChannels as jest.Mock).mockResolvedValueOnce([]);
      await initNotifications();
    });

    it('still sets identityKeyConflict + conflictSource(push) — the security tripwire must not be gated on display capability', async () => {
      mockPlatform('ios', 17);
      (notifee.getChannels as jest.Mock).mockRejectedValueOnce(new Error('native bridge unavailable'));
      await initNotifications(); // sets module-private notifeeAvailable = false

      mockIsRecoveryInitiator.mockReturnValue(false);
      const cb = getOnMessageCallback();
      await cb({ data: { t: 'identity_key_reset', v: '1' } });

      expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
      expect(mockSetConflictSource).toHaveBeenCalledWith('push');
      // Display is still gated on Notifee availability — banner is skipped.
      expect(notifee.displayNotification).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// setupNotificationTapHandler
// ---------------------------------------------------------------------------

describe('setupNotificationTapHandler', () => {
  it('registers onNotificationOpenedApp handler', () => {
    setupNotificationTapHandler();

    expect(getMessagingInstance().onNotificationOpenedApp).toHaveBeenCalledTimes(1);
    expect(typeof (getMessagingInstance().onNotificationOpenedApp as jest.Mock).mock.calls[0][0]).toBe('function');
  });

  it('cleanup unsubscribes onNotificationOpenedApp', () => {
    const mockUnsubOpenedApp = jest.fn();
    (getMessagingInstance().onNotificationOpenedApp as jest.Mock).mockReturnValueOnce(mockUnsubOpenedApp);

    const cleanup = setupNotificationTapHandler();
    cleanup();

    expect(mockUnsubOpenedApp).toHaveBeenCalled();
  });

  it('registers setPayloadConsumer', () => {
    const { setPayloadConsumer: mockSetPayloadConsumer } = require('../../navigation/navigationRef');

    setupNotificationTapHandler();

    expect(mockSetPayloadConsumer).toHaveBeenCalledTimes(1);
    expect(typeof mockSetPayloadConsumer.mock.calls[0][0]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// onForegroundEvent tap-handler callback (foreground tap, Notifee)
// ---------------------------------------------------------------------------

describe('setupNotificationTapHandler — onForegroundEvent press callback', () => {
  afterEach(() => {
    (navigationRef.isReady as jest.Mock).mockImplementation(() => false);
  });

  it('navigates when a foreground Notifee notification is pressed', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    setupNotificationTapHandler();
    const cb = (notifee.onForegroundEvent as jest.Mock).mock.calls[0][0];

    cb({
      type: EventType.PRESS,
      detail: { notification: { data: { t: 'new_dm', gid: 'conv-5' } } },
    });

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Chats',
      params: { screen: 'ChatDetail', params: { conversationId: 'conv-5' } },
    });
  });

  it('does not navigate for non-PRESS foreground events', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    setupNotificationTapHandler();
    const cb = (notifee.onForegroundEvent as jest.Mock).mock.calls[0][0];

    cb({
      type: EventType.DISMISSED,
      detail: { notification: { data: { t: 'new_dm', gid: 'conv-5' } } },
    });

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the pressed notification has no data', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    setupNotificationTapHandler();
    const cb = (notifee.onForegroundEvent as jest.Mock).mock.calls[0][0];

    cb({ type: EventType.PRESS, detail: { notification: undefined } });

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onNotificationOpenedApp tap-handler callback (background tap, iOS)
// ---------------------------------------------------------------------------

describe('setupNotificationTapHandler — onNotificationOpenedApp callback', () => {
  /** Capture the onNotificationOpenedApp callback registered by the handler. */
  function getOpenedAppCallback(): (
    msg: FirebaseMessagingTypes.RemoteMessage,
  ) => void {
    setupNotificationTapHandler();
    return (getMessagingInstance().onNotificationOpenedApp as jest.Mock).mock
      .calls[0][0];
  }

  afterEach(() => {
    (navigationRef.isReady as jest.Mock).mockImplementation(() => false);
  });

  it('navigates to ThreadDetail when tapping a new_thread notification', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'new_thread', tid: 'thread-123' }));

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Threads',
      params: {
        screen: 'ThreadDetail',
        params: { threadId: 'thread-123', targetReplyId: undefined },
      },
    });
  });

  it('navigates to ThreadDetail with targetReplyId when tapping a new_reply notification', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'new_reply', tid: 'thread-456', rid: 'reply-789' }));

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Threads',
      params: {
        screen: 'ThreadDetail',
        params: { threadId: 'thread-456', targetReplyId: 'reply-789' },
      },
    });
  });

  it('navigates to ChatDetail when tapping a new_dm notification', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'new_dm', gid: 'conv-1' }));

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Chats',
      params: { screen: 'ChatDetail', params: { conversationId: 'conv-1' } },
    });
  });

  it('navigates to JoinOrbit when tapping an orbit_invite notification', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'orbit_invite', code: 'INV-001' }));

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Threads',
      params: { screen: 'JoinOrbit', params: { code: 'INV-001' } },
    });
  });

  it('navigates to the Threads list when tapping a member_joined notification', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'member_joined', gid: 'group-1' }));

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Threads',
    });
  });

  it('does not navigate when the remoteMessage has no data', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb({} as FirebaseMessagingTypes.RemoteMessage);

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the payload type is unrecognized', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'unknown_type' }));

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  it('queues the payload instead of navigating when the nav tree is not ready', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(false);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'new_thread', tid: 'thread-123' }));

    expect(setPendingNotificationPayload).toHaveBeenCalledWith({
      t: 'new_thread',
      tid: 'thread-123',
    });
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // #539: identity_key_reset — background tap (iOS onNotificationOpenedApp)
  // -------------------------------------------------------------------------

  it('navigates to Settings and sets identityKeyConflict when tapping an identity_key_reset notification (background, not initiator)', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    mockIsRecoveryInitiator.mockReturnValue(false);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'identity_key_reset', v: '1' }));

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('push');
    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Settings',
    });
  });

  it('navigates to Settings but does not set identityKeyConflict when the recovery initiator taps their own push (background)', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    mockIsRecoveryInitiator.mockReturnValue(true);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'identity_key_reset', v: '1' }));

    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalled();
    expect(mockSetConflictSource).not.toHaveBeenCalled();
    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Settings',
    });
  });

  it('queuing an identity_key_reset payload alone (nav not ready) does not set identityKeyConflict', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(false);
    mockIsRecoveryInitiator.mockReturnValue(false);
    const cb = getOpenedAppCallback();

    cb(remoteMessage({ t: 'identity_key_reset', v: '1' }));

    expect(setPendingNotificationPayload).toHaveBeenCalledWith({
      t: 'identity_key_reset',
      v: '1',
    });
    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalled();
    expect(mockSetConflictSource).not.toHaveBeenCalled();
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #539: identity_key_reset — consuming a queued payload
// (covers both the Android onBackgroundEvent flow, which queues the payload
// directly via setPendingNotificationPayload in index.js, and the killed-state
// getInitialNotification flow below — both funnel into the same
// setPayloadConsumer callback once the nav tree is ready.)
// ---------------------------------------------------------------------------

describe('setupNotificationTapHandler — consuming a queued identity_key_reset payload', () => {
  /** Capture the consumer function registered via setPayloadConsumer. */
  function getPayloadConsumer(): (data: Record<string, string>) => void {
    const { setPayloadConsumer: mockSetPayloadConsumer } = require('../../navigation/navigationRef');
    setupNotificationTapHandler();
    return mockSetPayloadConsumer.mock.calls[0][0];
  }

  afterEach(() => {
    (navigationRef.isReady as jest.Mock).mockImplementation(() => false);
  });

  it('sets identityKeyConflict + conflictSource(push) and navigates to Settings when consuming a queued payload (not initiator)', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    mockIsRecoveryInitiator.mockReturnValue(false);
    const consumer = getPayloadConsumer();

    consumer({ t: 'identity_key_reset', v: '1' });

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('push');
    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Settings',
    });
  });

  it('does not set identityKeyConflict when consuming a queued payload as the recovery initiator', () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    mockIsRecoveryInitiator.mockReturnValue(true);
    const consumer = getPayloadConsumer();

    consumer({ t: 'identity_key_reset', v: '1' });

    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalled();
    expect(mockSetConflictSource).not.toHaveBeenCalled();
    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Settings',
    });
  });
});

// ---------------------------------------------------------------------------
// Killed-state getInitialNotification handling
// ---------------------------------------------------------------------------

describe('setupNotificationTapHandler — killed-state getInitialNotification', () => {
  afterEach(() => {
    (navigationRef.isReady as jest.Mock).mockImplementation(() => false);
  });

  it('navigates using the cold-start notification payload when nav is ready', async () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    (getMessagingInstance().getInitialNotification as jest.Mock).mockResolvedValueOnce(
      remoteMessage({ t: 'new_dm', gid: 'conv-99' }),
    );

    setupNotificationTapHandler();
    // Flush the getInitialNotification().then() microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Chats',
      params: { screen: 'ChatDetail', params: { conversationId: 'conv-99' } },
    });
  });

  it('queues the cold-start payload when the nav tree is not ready yet', async () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(false);
    (getMessagingInstance().getInitialNotification as jest.Mock).mockResolvedValueOnce(
      remoteMessage({ t: 'orbit_invite', code: 'INV-2' }),
    );

    setupNotificationTapHandler();
    await Promise.resolve();
    await Promise.resolve();

    expect(setPendingNotificationPayload).toHaveBeenCalledWith({
      t: 'orbit_invite',
      code: 'INV-2',
    });
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when there is no cold-start notification (returns null)', async () => {
    (getMessagingInstance().getInitialNotification as jest.Mock).mockResolvedValueOnce(
      null,
    );

    setupNotificationTapHandler();
    await Promise.resolve();
    await Promise.resolve();

    expect(navigationRef.navigate).not.toHaveBeenCalled();
    expect(setPendingNotificationPayload).not.toHaveBeenCalled();
  });

  it('swallows getInitialNotification rejection without throwing', async () => {
    (getMessagingInstance().getInitialNotification as jest.Mock).mockRejectedValueOnce(
      new Error('native bridge unavailable'),
    );

    expect(() => setupNotificationTapHandler()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // #539: identity_key_reset — killed-state cold start
  // -------------------------------------------------------------------------

  it('sets identityKeyConflict and navigates to Settings from a killed-state identity_key_reset notification (not initiator)', async () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(true);
    mockIsRecoveryInitiator.mockReturnValue(false);
    (getMessagingInstance().getInitialNotification as jest.Mock).mockResolvedValueOnce(
      remoteMessage({ t: 'identity_key_reset', v: '1' }),
    );

    setupNotificationTapHandler();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('push');
    expect(navigationRef.navigate).toHaveBeenCalledWith('MainTabs', {
      screen: 'Settings',
    });
  });

  it('queues a killed-state identity_key_reset payload without setting identityKeyConflict when the nav tree is not ready yet', async () => {
    (navigationRef.isReady as jest.Mock).mockReturnValue(false);
    mockIsRecoveryInitiator.mockReturnValue(false);
    (getMessagingInstance().getInitialNotification as jest.Mock).mockResolvedValueOnce(
      remoteMessage({ t: 'identity_key_reset', v: '1' }),
    );

    setupNotificationTapHandler();
    await Promise.resolve();
    await Promise.resolve();

    expect(setPendingNotificationPayload).toHaveBeenCalledWith({
      t: 'identity_key_reset',
      v: '1',
    });
    expect(mockSetIdentityKeyConflict).not.toHaveBeenCalled();
    expect(mockSetConflictSource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deregisterCurrentDevice
// ---------------------------------------------------------------------------

describe('deregisterCurrentDevice', () => {
  it('calls deregisterDevice with the device ID', async () => {
    await deregisterCurrentDevice();

    expect(mockDeregisterDevice).toHaveBeenCalledWith('mock-device-id');
  });

  it('does not throw when deregisterDevice fails', async () => {
    mockDeregisterDevice.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await expect(deregisterCurrentDevice()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #449: foreground suppression (D5) + per-thread collapse (D9)
//
// NOTE: pushDedupSet is module-private and shared by every test in this file,
// so each case below uses unique tid/rid values unless it is deliberately
// exercising dedup.
// ---------------------------------------------------------------------------

describe('setupForegroundHandler — #449 preference suppression', () => {
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  const PREF_OFF_CASES: [string, string, Record<string, string>][] = [
    ['new_thread', 'newThread', { t: 'new_thread', gid: 'g-pref-1', tid: 'tp-1' }],
    ['new_reply', 'newReply', { t: 'new_reply', gid: 'g-pref-2', tid: 'tp-2', rid: 'rp-2' }],
    ['new_dm', 'newDm', { t: 'new_dm', gid: 'g-pref-3' }],
    ['member_joined', 'memberJoined', { t: 'member_joined', gid: 'g-pref-4' }],
  ];

  const PREF_ON_CASES: [string, Record<string, string>][] = [
    ['new_thread', { t: 'new_thread', gid: 'g-on-1', tid: 'to-1' }],
    ['new_reply', { t: 'new_reply', gid: 'g-on-2', tid: 'to-2', rid: 'ro-2' }],
    ['new_dm', { t: 'new_dm', gid: 'g-on-3' }],
    ['member_joined', { t: 'member_joined', gid: 'g-on-4' }],
  ];

  it.each(PREF_OFF_CASES)('suppresses %s when its pref is off', async (_type, prefKey, payload) => {
    mockStoreState.notificationPrefs[prefKey] = false;
    const cb = getOnMessageCallback();

    await cb({ data: payload });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it.each(PREF_ON_CASES)('displays %s when all prefs are on', async (_type, payload) => {
    const cb = getOnMessageCallback();

    await cb({ data: payload });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('turning one pref off does not suppress the other types', async () => {
    mockStoreState.notificationPrefs.newThread = false;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'g-mix', tid: 'tm-1', rid: 'rm-1' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('fails open when the pref value is missing (no explicit false)', async () => {
    mockStoreState.notificationPrefs = {};
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'g-open', tid: 'tf-1', rid: 'rf-1' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });
});

describe('setupForegroundHandler — #449 DM group-type pref mapping', () => {
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  beforeEach(() => {
    // DMs are groups with a 'direct' conversation type whose traffic arrives
    // as new_thread/new_reply pushes.
    mockStoreState.conversations = {
      'dm-1': { id: 'dm-1', type: 'direct' },
      'orbit-1': { id: 'orbit-1', type: 'group' },
    };
  });

  it('gates a new_reply in a DM by newDm, not newReply', async () => {
    mockStoreState.notificationPrefs.newDm = false;
    mockStoreState.notificationPrefs.newReply = true;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'dm-1', tid: 'tdm-1', rid: 'rdm-1' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('still displays a DM reply when newReply is off but newDm is on', async () => {
    mockStoreState.notificationPrefs.newReply = false;
    mockStoreState.notificationPrefs.newDm = true;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'dm-1', tid: 'tdm-2', rid: 'rdm-2' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('gates an orbit reply by newReply, not newDm (inverse case)', async () => {
    mockStoreState.notificationPrefs.newDm = false;
    mockStoreState.notificationPrefs.newReply = true;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'orbit-1', tid: 'torb-1', rid: 'rorb-1' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('gates a new_thread in a DM by newDm', async () => {
    mockStoreState.notificationPrefs.newDm = false;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_thread', gid: 'dm-1', tid: 'tdm-3' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('falls back to the nominal pref key when the gid is not in the store', async () => {
    mockStoreState.notificationPrefs.newThread = false;
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_thread', gid: 'unknown-group', tid: 'tunk-1' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });
});

describe('setupForegroundHandler — #449 mute suppression', () => {
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  it('suppresses a new_reply carrying a muted tid', async () => {
    mockStoreState.mutedTargets = { 'tmute-1': 'thread' };
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'g-mute-1', tid: 'tmute-1', rid: 'rmute-1' } });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  const GROUP_MUTE_CASES: [string, Record<string, string>][] = [
    ['new_thread', { t: 'new_thread', gid: 'gmute-1', tid: 'tg-1' }],
    ['new_reply', { t: 'new_reply', gid: 'gmute-1', tid: 'tg-2', rid: 'rg-2' }],
    ['member_joined', { t: 'member_joined', gid: 'gmute-1' }],
  ];

  it.each(GROUP_MUTE_CASES)('a group mute suppresses %s for that gid', async (_type, payload) => {
    mockStoreState.mutedTargets = { 'gmute-1': 'group' };
    const cb = getOnMessageCallback();

    await cb({ data: payload });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('does not suppress pushes for a different, unmuted gid', async () => {
    mockStoreState.mutedTargets = { 'gmute-other': 'group' };
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_thread', gid: 'g-clear-1', tid: 'tc-1' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('a thread mute never matches a gid-only payload (negative case)', async () => {
    // Thread mutes are keyed on tid; a new_dm payload carries no tid, so it
    // can never be suppressed by one — by design (plan D7).
    mockStoreState.mutedTargets = { 'tonly-1': 'thread' };
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_dm', gid: 'gonly-1' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });

  it('suppressed pushes do NOT consume the dedup key', async () => {
    mockStoreState.mutedTargets = { 'tdedup-1': 'thread' };
    const cb = getOnMessageCallback();
    const payload = { t: 'new_reply', gid: 'g-dedup', tid: 'tdedup-1', rid: 'rdedup-1' };

    await cb({ data: payload });
    expect(notifee.displayNotification).not.toHaveBeenCalled();

    // Unmute and replay the same event — it must still be displayable.
    mockStoreState.mutedTargets = {};
    await cb({ data: payload });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });
});

describe('setupForegroundHandler — #449 identity_key_reset is never suppressible', () => {
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  it('dispatches the conflict flag and displays with every pref off and everything muted', async () => {
    mockStoreState.notificationPrefs = {
      newThread: false,
      newReply: false,
      newDm: false,
      memberJoined: false,
    };
    mockStoreState.mutedTargets = { 'g-sec': 'group', 't-sec': 'thread' };
    mockIsRecoveryInitiator.mockReturnValue(false);
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'identity_key_reset', v: '1' } });

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Security alert' }),
    );
  });

  it('displays even when a hypothetical payload carries a muted gid/tid (allowlist carve-out)', async () => {
    mockStoreState.mutedTargets = { 'g-sec': 'group', 't-sec': 'thread' };
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'identity_key_reset', v: '1', gid: 'g-sec', tid: 't-sec' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });
});

describe('setupForegroundHandler — #449 collapse key on display (D9)', () => {
  function getOnMessageCallback(): (msg: { data?: Record<string, string> }) => Promise<void> {
    setupForegroundHandler();
    return (getMessagingInstance().onMessage as jest.Mock).mock.calls[0][0];
  }

  function lastDisplayArg(): Record<string, unknown> {
    const calls = (notifee.displayNotification as jest.Mock).mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  }

  it('passes the tid as the notification id for new_reply and sets onlyAlertOnce', async () => {
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_reply', gid: 'g-col-1', tid: 'tcol-1', rid: 'rcol-1' } });

    const arg = lastDisplayArg();
    expect(arg.id).toBe('tcol-1');
    expect((arg.android as Record<string, unknown>).onlyAlertOnce).toBe(true);
  });

  it('passes the tid for new_thread', async () => {
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_thread', gid: 'g-col-2', tid: 'tcol-2' } });

    expect(lastDisplayArg().id).toBe('tcol-2');
  });

  it('passes the gid for new_dm and member_joined', async () => {
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_dm', gid: 'gcol-3' } });
    expect(lastDisplayArg().id).toBe('gcol-3');

    await cb({ data: { t: 'member_joined', gid: 'gcol-4' } });
    expect(lastDisplayArg().id).toBe('gcol-4');
  });

  it('omits the id for identity_key_reset — security alerts must stack', async () => {
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'identity_key_reset', v: '1' } });

    expect('id' in lastDisplayArg()).toBe(false);
  });

  it('omits the id when the collapse key cannot be derived', async () => {
    const cb = getOnMessageCallback();

    await cb({ data: { t: 'new_thread', gid: 'g-col-5' } });

    expect('id' in lastDisplayArg()).toBe(false);
  });
});
