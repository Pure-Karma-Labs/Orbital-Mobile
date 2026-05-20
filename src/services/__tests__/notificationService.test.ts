/**
 * Tests for notificationService — push notification permission, foreground
 * display, and device deregistration.
 *
 * Covers: requestPermissionAndRegister, setupForegroundHandler,
 * deregisterCurrentDevice.
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

import messaging from '@react-native-firebase/messaging';
import notifee from '@notifee/react-native';
import {
  requestPermissionAndRegister,
  setupForegroundHandler,
  deregisterCurrentDevice,
} from '../notificationService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the messaging singleton from the mock. */
function getMessagingInstance() {
  return messaging();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Reset default mock returns
  (getMessagingInstance().requestPermission as jest.Mock).mockResolvedValue(
    messaging.AuthorizationStatus.AUTHORIZED,
  );
  (getMessagingInstance().getToken as jest.Mock).mockResolvedValue('mock-fcm-token');
  (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValue(jest.fn());
});

// ---------------------------------------------------------------------------
// requestPermissionAndRegister
// ---------------------------------------------------------------------------

describe('requestPermissionAndRegister', () => {
  it('sets pushPermission(false) and returns early when permission is denied', async () => {
    (getMessagingInstance().requestPermission as jest.Mock).mockResolvedValueOnce(
      messaging.AuthorizationStatus.DENIED,
    );

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
    (getMessagingInstance().requestPermission as jest.Mock).mockResolvedValueOnce(
      messaging.AuthorizationStatus.PROVISIONAL,
    );

    await requestPermissionAndRegister();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(mockRegisterDevice).toHaveBeenCalled();
  });

  it('does not propagate error when registerDevice throws', async () => {
    mockRegisterDevice.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    const unsubscribe = await requestPermissionAndRegister();

    expect(mockSetPushPermission).toHaveBeenCalledWith(true);
    expect(typeof unsubscribe).toBe('function');
  });

  it('returns an unsubscribe function from onTokenRefresh', async () => {
    const mockUnsub = jest.fn();
    (getMessagingInstance().onTokenRefresh as jest.Mock).mockReturnValueOnce(mockUnsub);

    const unsubscribe = await requestPermissionAndRegister();

    expect(unsubscribe).toBe(mockUnsub);
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
