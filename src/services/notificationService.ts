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

import { Alert, AppState as RNAppState, Linking, PermissionsAndroid, Platform } from 'react-native';
import {
  getMessaging,
  getToken,
  onTokenRefresh,
  onMessage,
  onNotificationOpenedApp,
  getInitialNotification,
  type RemoteMessage,
} from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AuthorizationStatus, EventType, type Event as NotifeeEvent } from '@notifee/react-native';
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
  collapseKeyForPayload,
  isSuppressibleType,
  PREF_KEY_BY_TYPE,
} from './notificationConstants';
import { LRUSet } from './websocket/lruSet';
import { isRecoveryInitiator } from './recoveryState';

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** LRU set for foreground push deduplication (WS + push race). */
const pushDedupSet = new LRUSet(200);

/** Pending registration retry timer — cleared on logout cleanup. */
let retryTimerId: ReturnType<typeof setTimeout> | undefined;

// Module-scope owner of the single token-refresh listener. Re-registration
// replaces the previous listener; screens must never own this lifetime —
// a pushed settings screen unmounts on Back, and tearing the listener down
// there silently kills push delivery for the rest of the session (PR #677
// review finding). Teardown belongs to logout (App.tsx auth effect) and
// explicit push-disable only.
let activeTokenRefreshUnsub: (() => void) | undefined;

/**
 * Tear down push registration side-effects: the token-refresh listener and
 * any pending registration retry. Idempotent. Called on logout (directly, from
 * App.tsx's auth-effect cleanup) and when the user turns push off (via
 * `setPushEnabled(false)`).
 *
 * App.tsx calls this unconditionally rather than through a handle captured at
 * registration time (#683): an opted-out launch registers nothing and would
 * capture no handle, so a later in-screen ON would leave the listener installed
 * past logout.
 */
export function teardownPushRegistration(): void {
  activeTokenRefreshUnsub?.();
  activeTokenRefreshUnsub = undefined;
  if (retryTimerId != null) {
    clearTimeout(retryTimerId);
    retryTimerId = undefined;
  }
}

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
 * MODULE-INTERNAL (#683): registration is only ever reached through a gate that
 * consults `pushOptOut` — `registerIfEnabled()` (launch) or `setPushEnabled()`
 * (screen). Exporting this would reintroduce an ungated entry point that
 * silently overrides an explicit opt-out, which is the bug this issue fixes.
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
async function requestPermissionAndRegister(): Promise<() => void> {
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

  const settings = await notifee.requestPermission();

  const granted =
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL;

  useAppStore.getState().setPushPermission(granted);

  if (!granted) {
    if (__DEV__) console.warn('[Push] Permission not granted');
    return () => {};
  }

  const token = await getToken(getMessaging());
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

  // Listen for token refresh and re-register. The module owns the listener:
  // registering again replaces the previous one, and the returned closure is
  // just the module-level teardown (safe for App.tsx to call on logout even
  // if registration ran more than once — it always tears down the CURRENT
  // listener, never a stale one).
  activeTokenRefreshUnsub?.();
  activeTokenRefreshUnsub = onTokenRefresh(getMessaging(), async (newToken: string) => {
    useAppStore.getState().setPushToken(newToken);
    try {
      await registerDevice({ platform, pushToken: newToken, deviceId });
    } catch {
      if (__DEV__) console.warn('[Push] Token refresh re-registration failed');
    }
  });

  return teardownPushRegistration;
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
 * Launch-path push gate (#683).
 *
 * The ONLY registration entry point on the auth effect. Reads the persisted
 * `pushOptOut` intent:
 * - opted out → does NOT register, and awaits `deregisterCurrentDevice()` to
 *   RECONCILE. This is deliberately not a no-op: the DELETE issued when the
 *   user turned push off can fail (offline, 5xx), which would otherwise leave a
 *   live token server-side forever while the UI reads Off. The backend DELETE
 *   is a user-scoped soft delete: 204 on repeat while the row exists, 404 once
 *   it is gone (swallowed below), and covered by the IP-keyed 500/15min general
 *   limiter — safe at launch cadence; re-assess before any higher-frequency
 *   retry. `deregisterCurrentDevice` already swallows its own errors.
 * - not opted out → the internal `requestPermissionAndRegister()`.
 *
 * HYDRATION DEPENDENCY: this reads persisted state, so it is only correct if
 * `useAppStore.persist.rehydrate()` (bootstrap.ts) has already run. That call
 * is synchronous MMKV and precedes App.tsx's auth effect; keep it that way, or
 * an opted-out launch reads the default `false` and re-registers.
 */
export async function registerIfEnabled(): Promise<void> {
  if (useAppStore.getState().pushOptOut) {
    if (__DEV__) console.warn('[Push] Opted out — reconciling deregistration');
    await deregisterCurrentDevice();
    return;
  }
  await requestPermissionAndRegister();
}

/**
 * Apply a master-push transition (#683). Owns BOTH directions so the intent
 * write and the side-effects that enforce it cannot drift apart across callers.
 *
 * ON: writes intent FIRST (`setPushOptOut(false)`), then checks OS permission.
 * A tap is intent even when the OS has already denied us — the user who later
 * grants permission in Settings then converges at the next launch instead of
 * being silently held at opted-out. The DENIED branch alerts and returns
 * without registering; the flag stays `false`.
 *
 * OFF: intent → teardown listener/retry → deregister device → clear the
 * OS-derived state. Deregistration is awaited but never throws (best-effort);
 * a failure here reconciles at the next launch via `registerIfEnabled`.
 */
export async function setPushEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    useAppStore.getState().setPushOptOut(false);

    const settings = await notifee.getNotificationSettings();
    if (settings.authorizationStatus === AuthorizationStatus.DENIED) {
      Alert.alert(
        'Notifications Disabled',
        'Push notifications were previously denied. Enable them in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }

    await requestPermissionAndRegister();
    return;
  }

  useAppStore.getState().setPushOptOut(true);
  teardownPushRegistration();
  await deregisterCurrentDevice();
  useAppStore.getState().setPushPermission(false);
  useAppStore.getState().setPushToken(null);
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
  const unsubscribe = onMessage(getMessaging(),
    async (remoteMessage: RemoteMessage) => {
      const data = remoteMessage.data;

      // #539: identity_key_reset is a security tripwire and must run even
      // when Notifee is unavailable (New Architecture edge case) — only
      // banner *display* should be gated on notifeeAvailable, not the
      // conflict-flag dispatch. Flip the key-conflict gate immediately
      // (before any display attempt) unless THIS device initiated the
      // recovery (would be a self-triggered false positive — see
      // keyRecoveryService's transient initiator flag).
      if (data && data.t === 'identity_key_reset' && !isRecoveryInitiator()) {
        useAppStore.getState().setIdentityKeyConflict(true);
        useAppStore.getState().setConflictSource('push');
      }

      if (!notifeeAvailable) return;
      if (!data) return;

      const type = data.t as string | undefined;
      if (!type) return;

      // Foreground suppression: skip if user is viewing the target conversation/group
      const suppressible = type === 'new_thread' || type === 'new_reply' || type === 'new_dm';
      if (suppressible && data.gid && useAppStore.getState().viewingConversationId === data.gid) {
        return;
      }

      // #449 (D5): per-type preference + per-target mute suppression.
      // Runs BEFORE dedup so a suppressed push does not consume the dedup key
      // (otherwise a later legitimate display of the same event is swallowed).
      // Only types in the allowlist are filterable — identity_key_reset is
      // structurally exempt (not in SUPPRESSIBLE_TYPES, and server-side it
      // routes through the unfiltered sendPush path).
      if (isSuppressibleType(type)) {
        // Firebase types `data` values as `string | object`; push payloads are
        // always flat strings (see the push payload allowlist server-side).
        const { gid, tid } = data as Record<string, string>;
        const state = useAppStore.getState();
        // DM conversations are groups whose traffic arrives as
        // new_thread/new_reply, so the effective pref key is resolved from the
        // target conversation's type, not from `t` alone (plan D5).
        const conversation = gid ? state.conversations?.[gid] : undefined;
        const prefKey =
          conversation?.type === 'direct' ? 'newDm' : PREF_KEY_BY_TYPE[type];
        // Fail-open: only an explicit `false` suppresses.
        if (state.notificationPrefs?.[prefKey] === false) return;
        if (tid && state.mutedTargets?.[tid] !== undefined) return;
        if (gid && state.mutedTargets?.[gid] !== undefined) return;
      }

      // Push dedup — skip if we already displayed this event
      const dedupKey = dedupKeyForPayload(data as Record<string, string>);
      if (dedupKey && pushDedupSet.has(dedupKey)) return;
      if (dedupKey) pushDedupSet.add(dedupKey);

      const title = NOTIFICATION_TITLES[type];
      if (!title) return;

      // #449 (D9): collapse replies to one thread/conversation into a single
      // tray entry. Reusing the notification id makes each new push REPLACE
      // the previous one; onlyAlertOnce keeps the replacement quiet.
      // identity_key_reset has no collapse key — security alerts must stack.
      const collapseKey = collapseKeyForPayload(data as Record<string, string>);

      try {
        await notifee.displayNotification({
          title,
          body: 'Tap to view',
          data: data as Record<string, string>,
          ...(collapseKey ? { id: collapseKey } : {}),
          android: {
            channelId: ANDROID_CHANNEL_ID,
            smallIcon: 'ic_notification',
            importance: AndroidImportance.HIGH,
            pressAction: { id: 'default' },
            onlyAlertOnce: true,
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
    // Queuing alone does not mutate state (see below) — only actual consumption does.
    setPendingNotificationPayload(data);
    return;
  }

  // #539: identity_key_reset push consumed via tap (background tap or a
  // flushed killed-state/queued payload — this function is the single
  // consumer registered via setPayloadConsumer for both onBackgroundEvent
  // and getInitialNotification flows). Flip the key-conflict gate unless
  // THIS device initiated the recovery.
  if (data.t === 'identity_key_reset' && !isRecoveryInitiator()) {
    useAppStore.getState().setIdentityKeyConflict(true);
    useAppStore.getState().setConflictSource('push');
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
    case 'settings':
      navigationRef.navigate('MainTabs', { screen: 'Settings' });
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
  const unsubOpenedApp = onNotificationOpenedApp(getMessaging(),
    (remoteMessage: RemoteMessage) => {
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
  getInitialNotification(getMessaging())
    .then((remoteMessage: RemoteMessage | null) => {
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
