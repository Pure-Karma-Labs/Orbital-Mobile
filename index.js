/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import './src/sentryInit';
import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, EventType } from '@notifee/react-native';
import App from './src/App';
import { name as appName } from './app.json';
import {
  NOTIFICATION_TITLES,
  ANDROID_CHANNEL_ID,
  ANDROID_CHANNEL_NAME,
  dedupKeyForPayload,
  collapseKeyForPayload,
} from './src/services/notificationConstants';
import { LRUSet } from './src/services/websocket/lruSet';

enableScreens();

// LRU set for background push deduplication.
const bgDedupSet = new LRUSet(200);

// Create Android notification channel eagerly at bundle load.
// The background message handler (below) fires at JS bundle load time —
// before auth and before initNotifications(). Displaying a notification
// on a non-existent channel is silently dropped on Android.
// This call is idempotent — calling it again in initNotifications() is harmless.
notifee.createChannel({
  id: ANDROID_CHANNEL_ID,
  name: ANDROID_CHANNEL_NAME,
  importance: AndroidImportance.HIGH,
});

// Must be registered at module top-level BEFORE AppRegistry.registerComponent.
// Without this, Android data-only push payloads are silently consumed when the
// app is killed or backgrounded — no system notification appears.
setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
  const data = remoteMessage.data;
  if (!data || !data.t) return;

  // Background dedup — skip if we already displayed this event
  const dedupKey = dedupKeyForPayload(data);
  if (dedupKey && bgDedupSet.has(dedupKey)) return;
  if (dedupKey) bgDedupSet.add(dedupKey);

  const title = NOTIFICATION_TITLES[data.t] || 'Orbital';

  // #449 (D9): collapse per thread/conversation so replies replace rather than
  // stack. Pure payload derivation — this handler runs before bootstrap, so it
  // still reads no store, MMKV, or database state. Suppression by preference or
  // mute is server-side only for background pushes (a plaintext mirror of the
  // muted-target ids would leak them at rest).
  const collapseKey = collapseKeyForPayload(data);

  await notifee.displayNotification({
    title,
    body: 'Tap to view',
    data,
    ...(collapseKey ? { id: collapseKey } : {}),
    android: {
      channelId: ANDROID_CHANNEL_ID,
      smallIcon: 'ic_notification',
      importance: AndroidImportance.HIGH,
      pressAction: { id: 'default' },
      onlyAlertOnce: true,
    },
  });
});

// Must be registered at module top-level per Notifee docs.
// Handles notification taps when the app is in the background or killed state.
// Navigation is deferred — the payload is queued and flushed once the React
// tree mounts and the navigation container is ready.
import { setPendingNotificationPayload } from './src/navigation/navigationRef';

notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.PRESS && detail.notification?.data) {
    setPendingNotificationPayload(detail.notification.data);
  }
});

AppRegistry.registerComponent(appName, () => App);
