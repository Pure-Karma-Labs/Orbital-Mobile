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

import { AppState as RNAppState, PermissionsAndroid, Platform } from 'react-native';
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
import {
  NOTIFICATION_TITLES,
  ANDROID_CHANNEL_ID,
  ANDROID_CHANNEL_NAME,
  resolveAnchor,
  dedupKeyForPayload,
} from './notificationConstants';
import { LRUSet } from './websocket/lruSet';

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** LRU set for foreground push deduplication (WS + push race). */
const pushDedupSet = new LRUSet(200);

/** Timer ID for the device registration retry so it can be cleared on logout. */
let retryTimerId: ReturnType<typeof setTimeout> | undefined;

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
  // Android 13+ (API 33) requires explicit runtime permission request
  // for POST_NOTIFICATIONS. Firebase's requestPermission() handles iOS
  // but may not trigger the Android system dialog.
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      useAppStore.getState().setPushPermission(false);
      if (__DEV__) console.warn('[Push] POST_NOTIFICATIONS denied');
      return () => {};
    }
  }

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
  if (__DEV__) console.warn(`[Push] FCM token obtained (${token.length} chars)`);
  useAppStore.getState().setPushToken(token);

  const deviceId = getDeviceId();
  const platform = Platform.OS as 'ios' | 'android';

  try {
    await registerDevice({ platform, pushToken: token, deviceId });
    if (__DEV__) console.warn('[Push] Device registered with backend');
  } catch {
    if (__DEV__) console.warn('[Push] Device registration failed, retrying in 5s');
    retryTimerId = setTimeout(async () => {
      retryTimerId = undefined;
      try {
        await registerDevice({ platform, pushToken: token, deviceId });
      } catch {
        if (__DEV__) console.warn('[Push] Device registration retry failed');
      }
    }, 5000);
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

  return () => {
    unsubTokenRefresh();
    if (retryTimerId != null) {
      clearTimeout(retryTimerId);
      retryTimerId = undefined;
    }
  };
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
 * Foreground suppression: if the user is currently viewing the conversation
 * that the notification targets, the notification is not displayed.
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

      // Foreground suppression: skip if user is viewing the target conversation/group
      const suppressible = type === 'new_thread' || type === 'new_reply' || type === 'new_dm';
      if (suppressible && data.gid && useAppStore.getState().viewingConversationId === data.gid) {
        return;
      }

      // Push dedup — skip if we already displayed this event
      const dedupKey = dedupKeyForPayload(data as Record<string, string>);
      if (dedupKey && pushDedupSet.has(dedupKey)) return;
      if (dedupKey) pushDedupSet.add(dedupKey);

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
        if (__DEV__) console.warn(`[Push] Foreground notification displayed: ${type}`);

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
 * Uses resolveAnchor() to parse the payload into a typed destination, then
 * navigates via the root stack → tab → nested stack hierarchy.
 *
 * Missing or malformed data results in no navigation (resolveAnchor returns null).
 */
function navigateFromNotification(data: Record<string, string>): void {
  if (!navigationRef.isReady()) {
    // Navigation tree not mounted yet (killed-state cold start).
    // Queue the payload — it will be flushed from NavigationContainer's onReady.
    setPendingNotificationPayload(data);
    return;
  }

  const anchor = resolveAnchor(data);
  if (!anchor) return;

  switch (anchor.type) {
    case 'thread':
      navigationRef.navigate('MainTabs', {
        screen: 'Threads',
        params: {
          screen: 'ThreadDetail',
          params: {
            threadId: anchor.threadId,
            targetReplyId: anchor.targetReplyId,
          },
        },
      });
      break;
    case 'chat':
      navigationRef.navigate('MainTabs', {
        screen: 'Chats',
        params: {
          screen: 'ChatDetail',
          params: { conversationId: anchor.conversationId },
        },
      });
      break;
    case 'joinOrbit':
      navigationRef.navigate('MainTabs', {
        screen: 'Threads',
        params: {
          screen: 'JoinOrbit',
          params: { code: anchor.code },
        },
      });
      break;
    case 'threadsList':
      navigationRef.navigate('MainTabs', { screen: 'Threads' });
      break;
  }
}

// ---------------------------------------------------------------------------
// Tap handler + badge management
// ---------------------------------------------------------------------------

/**
 * Set up notification tap handling from all launch states, plus an
 * AppState listener that clears the badge when the app comes to the foreground.
 *
 * Four notification tap sources:
 * 1. **Foreground tap** — user taps a local notification displayed by Notifee
 * 2a. **Background tap (iOS)** — Firebase onNotificationOpenedApp for APNs alerts
 * 2b. **Background tap (Android)** — Notifee onBackgroundEvent in index.js
 * 3. **Killed-state tap** — app was terminated; Firebase getInitialNotification()
 *
 * Returns an unsubscribe function that removes all event listeners. The Notifee
 * background event handler is registered globally (does not return an unsubscribe)
 * per Notifee API design.
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

  // 2a. Background tap (iOS) — Firebase notification opened from background state.
  // On iOS, the system displays the APNs alert notification (not Notifee),
  // so tapping it fires this handler rather than Notifee's onBackgroundEvent.
  const unsubOpenedApp = messaging().onNotificationOpenedApp(
    (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
      if (remoteMessage?.data) {
        navigateFromNotification(remoteMessage.data as Record<string, string>);
      }
    },
  );

  // 2b. Background tap (Android) — handled by onBackgroundEvent in index.js
  // (must be registered at module top-level per Notifee docs). Background taps
  // queue the payload via setPendingNotificationPayload, flushed on nav onReady.

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
    unsubOpenedApp();
    appStateSubscription.remove();
  };
}
