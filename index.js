/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import * as Sentry from '@sentry/react-native';
import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, EventType } from '@notifee/react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { SENTRY_DSN } from './src/config/env';

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    sendDefaultPii: false,
  });
}

enableScreens();

// Must be registered at module top-level BEFORE AppRegistry.registerComponent.
// Without this, Android data-only push payloads are silently consumed when the
// app is killed or backgrounded — no system notification appears.
messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  const data = remoteMessage.data;
  if (!data || !data.t) return;

  const titles = {
    new_thread: 'New thread in an Orbit',
    new_reply: 'New reply in a thread',
    new_dm: 'New direct message',
    orbit_invite: "You've been invited to an Orbit",
  };
  const title = titles[data.t] || 'Orbital';

  await notifee.displayNotification({
    title,
    body: 'Tap to view',
    data,
    android: {
      channelId: 'orbital-default',
      smallIcon: 'ic_notification',
      importance: AndroidImportance.HIGH,
      pressAction: { id: 'default' },
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
