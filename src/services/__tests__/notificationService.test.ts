/**
 * Tests for notificationService — push notification permission, foreground
 * display, tap handling, and device deregistration.
 *
 * Covers: requestPermissionAndRegister, setupForegroundHandler,
 * setupNotificationTapHandler, deregisterCurrentDevice.
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

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setPushPermission: mockSetPushPermission,
      setPushToken: mockSetPushToken,
    })),
  },
}));

jest.mock('../../navigation/navigationRef', () => ({
  navigationRef: { isReady: jest.fn(() => false), navigate: jest.fn() },
  setPendingNotificationPayload: jest.fn(),
  setPayloadConsumer: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PermissionsAndroid, Platform } from 'react-native';
import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import {
  requestPermissionAndRegister,
  setupForegroundHandler,
  setupNotificationTapHandler,
  deregisterCurrentDevice,
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
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// requestPermissionAndRegister
// ---------------------------------------------------------------------------

describe('requestPermissionAndRegister', () => {
  it('sets pushPermission(false) and returns early when permission is denied', async () => {
    (notifee.requestPermission as jest.Mock).mockResolvedValueOnce({
      authorizationStatus: 0, // DENIED
    });

    const unsubscribe = await requestPermissionAndRegister();

    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    expect(getMessagingInstance().getToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(typeof unsubscribe).toBe('function');
  });

  it('gets token and registers device when permission is granted', async () => {
    const unsubscribe = await requestPermissionAndRegister();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(getMessagingInstance().getToken).toHaveBeenCalled();
    expect(mockSetPushToken).toHaveBeenCalledWith('mock-fcm-token');
    expect(mockRegisterDevice).toHaveBeenCalledWith({
      platform: expect.stringMatching(/^(ios|android)$/),
      pushToken: 'mock-fcm-token',
      deviceId: 'mock-device-id',
    });
    expect(typeof unsubscribe).toBe('function');
  });

  it('sets pushPermission(true) when provisional permission is granted', async () => {
    (notifee.requestPermission as jest.Mock).mockResolvedValueOnce({
      authorizationStatus: 2, // PROVISIONAL
    });

    await requestPermissionAndRegister();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(mockRegisterDevice).toHaveBeenCalled();
  });

  it('retries registration after 5s when registerDevice throws', async () => {
    mockRegisterDevice
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ success: true });

    await requestPermissionAndRegister();

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
    await requestPermissionAndRegister();

    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    // Both calls made, no error propagated
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2);
  });

  it('returns a cleanup function that calls onTokenRefresh unsubscribe', async () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValueOnce(mockUnsub);

    const cleanup = await requestPermissionAndRegister();
    expect(typeof cleanup).toBe('function');

    cleanup();
    expect(mockUnsub).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requestPermissionAndRegister — Android 13+ POST_NOTIFICATIONS permission
// ---------------------------------------------------------------------------

describe('requestPermissionAndRegister — Android 13+ POST_NOTIFICATIONS permission', () => {
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

    await requestPermissionAndRegister();

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

    const unsubscribe = await requestPermissionAndRegister();

    expect(requestSpy).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    expect(mockSetPushPermission).toHaveBeenCalledWith(false);
    // Should return early — Notifee/Firebase permission flow never runs.
    expect(notifee.requestPermission).not.toHaveBeenCalled();
    expect(getMessagingInstance().getToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(typeof unsubscribe).toBe('function');
  });

  it('skips the POST_NOTIFICATIONS check entirely below API 33', async () => {
    mockPlatform('android', 32);
    requestSpy = jest.spyOn(PermissionsAndroid, 'request');

    await requestPermissionAndRegister();

    expect(requestSpy).not.toHaveBeenCalled();
    // Falls through directly to the Notifee/Firebase flow.
    expect(notifee.requestPermission).toHaveBeenCalled();
    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
  });

  it('does not invoke PermissionsAndroid.request on iOS regardless of Platform.Version', async () => {
    mockPlatform('ios', 33);
    requestSpy = jest.spyOn(PermissionsAndroid, 'request');

    await requestPermissionAndRegister();

    expect(requestSpy).not.toHaveBeenCalled();
    expect(notifee.requestPermission).toHaveBeenCalled();
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
