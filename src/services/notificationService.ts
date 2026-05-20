/**
 * Push notification service.
 *
 * Handles Firebase Cloud Messaging permission, token management, foreground
 * display via Notifee, and device registration with the Orbital backend.
 *
 * Security: Push payloads are content-free event signals. No message content,
 * thread titles, or sender names are included. The client fetches encrypted
 * content via API after the user taps a notification.
 *
 * Security: Raw FCM/APNs tokens are never logged. Only generic status messages
 * appear in catch blocks (review finding #7).
 */

import { Platform } from 'react-native';
import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import notifee, { AndroidImportance } from '@notifee/react-native';
import { registerDevice, deregisterDevice } from './api/devices';
import { getDeviceId } from './deviceId';
import { useAppStore } from '../stores/useAppStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANDROID_CHANNEL_ID = 'orbital-default';
const ANDROID_CHANNEL_NAME = 'Orbital';

/** Maps push payload type to a content-free display title. */
const NOTIFICATION_TITLES: Record<string, string> = {
  new_thread: 'New thread in an Orbit',
  new_reply: 'New reply in a thread',
  new_dm: 'New direct message',
  orbit_invite: "You've been invited to an Orbit",
};

// ---------------------------------------------------------------------------
// Notifee availability check
// ---------------------------------------------------------------------------

let notifeeAvailable = true;

/**
 * Check whether Notifee's native module is actually usable.
 * In some New Architecture edge cases the module can be linked but crash at
 * runtime. We test eagerly so the rest of the service can fall back cleanly.
 */
async function checkNotifeeAvailability(): Promise<boolean> {
  try {
    // createChannel is a lightweight call that exercises the native bridge
    await notifee.createChannel({
      id: ANDROID_CHANNEL_ID,
      name: ANDROID_CHANNEL_NAME,
      importance: AndroidImportance.HIGH,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One-time setup. Creates the Android notification channel via Notifee.
 * On iOS this is a no-op (APNs doesn't use channels).
 *
 * Call once after app launch, before requesting permissions.
 */
export async function initNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    notifeeAvailable = await checkNotifeeAvailability();
  }
  // iOS: Notifee channel creation is silently ignored, so this is safe to call
  // unconditionally. But we still verify availability for foreground display.
  if (Platform.OS === 'ios') {
    try {
      // Idempotent call to verify the native module loads without consuming
      // a cold-start notification (getInitialNotification is one-shot).
      await notifee.getChannels();
      notifeeAvailable = true;
    } catch {
      notifeeAvailable = false;
    }
  }
}

/**
 * Request push notification permission and register the device with the backend.
 *
 * Flow:
 * 1. Request permission via Firebase Messaging
 * 2. Get FCM token
 * 3. Register device with backend (POST /api/devices/register)
 * 4. Listen for token refresh to re-register automatically
 *
 * Stores permission state and token in the notification store slice.
 *
 * @returns Unsubscribe function for the token refresh listener.
 */
export async function requestPermissionAndRegister(): Promise<() => void> {
  const authStatus = await messaging().requestPermission();

  const granted =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  useAppStore.getState().setPushPermission(granted);

  if (!granted) {
    if (__DEV__) console.warn('[Push] Permission not granted');
    return () => {};
  }

  const token = await messaging().getToken();
  useAppStore.getState().setPushToken(token);

  const deviceId = getDeviceId();
  const platform = Platform.OS as 'ios' | 'android';

  try {
    await registerDevice({ platform, pushToken: token, deviceId });
  } catch (e: unknown) {
    // Don't block the app if registration fails — will retry on next launch
    if (__DEV__) console.warn('[Push] Device registration failed');
  }

  // Listen for token refresh and re-register.
  // Returns unsubscribe so the caller can tear down on logout.
  const unsubTokenRefresh = messaging().onTokenRefresh(async (newToken: string) => {
    useAppStore.getState().setPushToken(newToken);
    try {
      await registerDevice({ platform, pushToken: newToken, deviceId });
    } catch {
      if (__DEV__) console.warn('[Push] Token refresh re-registration failed');
    }
  });

  return unsubTokenRefresh;
}

/**
 * Best-effort device deregistration. Called during logout.
 * Catches all errors so it never blocks the logout flow.
 */
export async function deregisterCurrentDevice(): Promise<void> {
  try {
    const deviceId = getDeviceId();
    await deregisterDevice(deviceId);
  } catch {
    // Best-effort — don't block logout if deregistration fails.
    // The backend will deactivate stale tokens via Firebase error callbacks.
    if (__DEV__) console.warn('[Push] Device deregistration failed');
  }
}

/**
 * Set up foreground notification display handler.
 *
 * When the app is in the foreground, Firebase Messaging delivers the message
 * silently (no system notification). We use Notifee to display a local
 * notification with a content-free title based on the payload type.
 *
 * If Notifee is not available (New Architecture incompatibility), this is a
 * no-op — foreground messages are silently consumed. This is acceptable for
 * v1: the user is already in the app and will see new content via WebSocket.
 *
 * @returns Unsubscribe function to tear down the listener.
 */
export function setupForegroundHandler(): () => void {
  const unsubscribe = messaging().onMessage(
    async (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
      if (!notifeeAvailable) return;

      const data = remoteMessage.data;
      if (!data) return;

      const type = data.t as string | undefined;
      if (!type) return;

      const title = NOTIFICATION_TITLES[type];
      if (!title) return;

      try {
        await notifee.displayNotification({
          title,
          body: 'Tap to view',
          android: {
            channelId: ANDROID_CHANNEL_ID,
            smallIcon: 'ic_notification',
            importance: AndroidImportance.HIGH,
            pressAction: { id: 'default' },
          },
        });
      } catch {
        // Notifee display failed — swallow silently.
        // User is in the foreground and will see content via WebSocket.
      }
    },
  );

  return unsubscribe;
}
