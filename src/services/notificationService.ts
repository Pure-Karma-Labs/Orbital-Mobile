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

import { AppState as RNAppState, Platform } from 'react-native';
import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, EventType, type Event as NotifeeEvent } from '@notifee/react-native';
import { registerDevice, deregisterDevice } from './api/devices';
import { getDeviceId } from './deviceId';
import { useAppStore } from '../stores/useAppStore';
import {
  navigationRef,
  setPendingNotificationPayload,
  setPayloadConsumer,
} from '../navigation/navigationRef';

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
          data: data as Record<string, string>,
          android: {
            channelId: ANDROID_CHANNEL_ID,
            smallIcon: 'ic_notification',
            importance: AndroidImportance.HIGH,
            pressAction: { id: 'default' },
          },
        });

        // Increment badge count so the app icon reflects unread notifications.
        // Primarily meaningful on iOS; Android badge behavior is launcher-dependent.
        if (Platform.OS === 'ios') {
          const currentBadge = await notifee.getBadgeCount();
          await notifee.setBadgeCount(currentBadge + 1);
        }
      } catch {
        // Notifee display failed — swallow silently.
        // User is in the foreground and will see content via WebSocket.
      }
    },
  );

  return unsubscribe;
}

// ---------------------------------------------------------------------------
// Navigation from notification data
// ---------------------------------------------------------------------------

/**
 * Navigate to the appropriate screen based on push notification payload data.
 *
 * Payload fields:
 * - `t`: notification type — 'new_thread' | 'new_reply' | 'new_dm' | 'orbit_invite'
 * - `gid`: group/conversation ID
 * - `tid`: thread ID (for new_thread and new_reply)
 * - `code`: invite code (for orbit_invite)
 *
 * Missing or empty IDs are silently ignored (no navigation).
 */
function navigateFromNotification(data: Record<string, string>): void {
  const { t, gid, tid, code } = data;

  if (!t) return;

  if (!navigationRef.isReady()) {
    // Navigation tree not mounted yet (killed-state cold start).
    // Queue the payload — it will be flushed from NavigationContainer's onReady.
    setPendingNotificationPayload(data);
    return;
  }

  switch (t) {
    case 'new_thread':
    case 'new_reply':
      if (!tid) return;
      // Navigate into the Threads tab → ThreadDetail
      navigationRef.navigate('MainTabs', {
        screen: 'Threads',
        params: {
          screen: 'ThreadDetail',
          params: { threadId: tid },
        },
      });
      break;

    case 'new_dm':
      if (!gid) return;
      // Navigate into the Chats tab → ChatDetail
      navigationRef.navigate('MainTabs', {
        screen: 'Chats',
        params: {
          screen: 'ChatDetail',
          params: { conversationId: gid },
        },
      });
      break;

    case 'orbit_invite':
      if (!code) return;
      // Navigate into the Threads tab → JoinOrbit with prefilled code
      navigationRef.navigate('MainTabs', {
        screen: 'Threads',
        params: {
          screen: 'JoinOrbit',
          params: { code },
        },
      });
      break;

    default:
      // Unknown notification type — no-op
      break;
  }
}

// ---------------------------------------------------------------------------
// Tap handler + badge management
// ---------------------------------------------------------------------------

/**
 * Set up notification tap handling from all three launch states, plus an
 * AppState listener that clears the badge when the app comes to the foreground.
 *
 * Three notification tap sources:
 * 1. **Foreground tap** — user taps a local notification displayed by Notifee
 * 2. **Background tap** — app was backgrounded; user taps the system notification
 * 3. **Killed-state tap** — app was terminated; Firebase getInitialNotification()
 *
 * Returns an unsubscribe function that removes the Notifee foreground event
 * listener and the AppState listener. The Notifee background event handler is
 * registered globally (does not return an unsubscribe) per Notifee API design.
 *
 * Call once after authentication — typically in the useEffect([isAuthenticated])
 * block in App.tsx.
 */
export function setupNotificationTapHandler(): () => void {
  // Register the navigation consumer so queued payloads can be flushed
  // from NavigationContainer's onReady callback.
  setPayloadConsumer(navigateFromNotification);

  // 1. Foreground tap — Notifee local notification press events
  const unsubForegroundEvent = notifee.onForegroundEvent(
    ({ type, detail }: NotifeeEvent) => {
      if (type === EventType.PRESS && detail.notification?.data) {
        navigateFromNotification(detail.notification.data as Record<string, string>);
      }
    },
  );

  // 2. Background tap — handled by onBackgroundEvent in index.js (must be
  // registered at module top-level per Notifee docs). Background taps queue
  // the payload via setPendingNotificationPayload, flushed on nav onReady.

  // 3. Killed-state tap — Firebase getInitialNotification() is one-shot.
  // If the nav tree isn't ready yet, the payload is queued automatically
  // by navigateFromNotification → setPendingNotificationPayload.
  messaging()
    .getInitialNotification()
    .then((remoteMessage: FirebaseMessagingTypes.RemoteMessage | null) => {
      if (remoteMessage?.data) {
        navigateFromNotification(remoteMessage.data as Record<string, string>);
      }
    })
    .catch(() => {
      // Swallow — not critical. Killed-state tap is best-effort.
    });

  // 4. Badge clear on app foreground.
  // When the user brings the app to the foreground, clear the badge count.
  // Primarily meaningful on iOS; Android badge behavior is launcher-dependent.
  const appStateSubscription = RNAppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') {
      notifee.setBadgeCount(0).catch(() => {
        // Badge clear is best-effort — swallow errors.
      });
    }
  });

  return () => {
    unsubForegroundEvent();
    appStateSubscription.remove();
  };
}
