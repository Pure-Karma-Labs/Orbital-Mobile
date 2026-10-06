/**
 * Background push registration — the Android killed/backgrounded display path.
 *
 * This is the code that used to live untyped at the top level of index.js
 * (#771). `tsconfig.json` has no `checkJs`, so while it lived in index.js an
 * upstream rename or signature change in @react-native-firebase/messaging or
 * @notifee/react-native kept compiling, and the wiring test still passed
 * because it read `mock.calls[0][1]`. The failure mode was a silent loss of
 * Android background notifications. Here, the typed RNFB mock contract (#667)
 * plus the derived handler types below make an argument-order or handler-
 * signature change a `tsc --noEmit` failure. They do NOT cover the message
 * DATA shape — `remoteMessage.data` is cast below, exactly as the foreground
 * handler casts it, so a payload-shape change stays a runtime concern.
 *
 * PRE-BOOTSTRAP PURITY — this module is loaded from index.js at bundle load,
 * BEFORE bootstrap and before encrypted MMKV is open, and the background
 * message handler can fire in a headless JS context where the React tree never
 * mounts. It must therefore stay free of store, MMKV, database, API,
 * keychain/secure-storage and telemetry imports; every decision it makes is a
 * pure function of the push payload. Type-only imports are fine (erased).
 * Mechanically enforced by invariant 19 [pre-bootstrap-pure] in
 * scripts/check-security-invariants.mjs, which allowlists this file and
 * notificationConstants.ts.
 *
 * Consequence of that purity: background pushes are NOT filtered by
 * notification preferences or per-target mutes. Background suppression is
 * server-side only — a plaintext mirror of the muted-target ids would leak
 * them at rest.
 *
 * WHY index.js CALLS registerBackgroundPushHandlers() EXPLICITLY, and does not
 * `import './src/services/backgroundPush'` for its side effects: Metro enables
 * `inlineRequires` by default (@react-native/metro-config), and this repo does
 * not override it. Under inlineRequires a named import is required lazily at
 * first use, but a bare side-effect import runs EAGERLY, ahead of
 * `enableScreens()`. An explicit call at today's position is the only form that
 * preserves the shipped on-device ordering. Jest does not apply
 * inlineRequires, so the wiring test CANNOT detect a conversion back to a
 * side-effect import — that is why the reason is recorded here and at the call
 * site rather than in a test.
 */

import notifee, { EventType } from '@notifee/react-native';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';

import { setPendingNotificationPayload } from '../navigation/navigationRef';
import {
  NOTIFICATION_TITLES,
  DEFAULT_CHANNEL,
  buildNotificationRequest,
  dedupKeyForPayload,
  collapseKeyForPayload,
} from './notificationConstants';
import { LRUSet } from './websocket/lruSet';

/**
 * The handler shape RNFB actually expects, derived from the real declaration
 * (a single, non-overloaded signature). If upstream changes the handler
 * signature or the argument order, this file stops compiling. The fields
 * INSIDE `remoteMessage.data` are not covered — see the header.
 */
type BackgroundMessageHandler = Parameters<typeof setBackgroundMessageHandler>[1];

/** Same contract for notifee's background event observer. */
type BackgroundEventHandler = Parameters<typeof notifee.onBackgroundEvent>[0];

/** LRU set for background push deduplication. */
const bgDedupSet = new LRUSet(200);

/** Set once registerBackgroundPushHandlers() has run; makes it idempotent. */
let registered = false;

/**
 * Display a data-only background push.
 *
 * Exported for the behaviour tests (src/services/__tests__/backgroundPush.test.ts)
 * and for the wiring test's identity assertion; production code reaches it only
 * through registerBackgroundPushHandlers().
 */
export const handleBackgroundMessage: BackgroundMessageHandler = async (remoteMessage) => {
  // Firebase types `data` values as `string | object`; push payloads are always
  // flat strings (server-side push payload allowlist), matching the cast in the
  // foreground handler.
  const data = remoteMessage.data as Record<string, string> | undefined;
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

  await notifee.displayNotification(buildNotificationRequest(data, title, collapseKey));
};

/**
 * Handle a notification tap while the app is backgrounded or killed.
 *
 * Navigation is deferred — the payload is queued and flushed once the React
 * tree mounts and the navigation container is ready.
 */
export const handleBackgroundEvent: BackgroundEventHandler = async ({ type, detail }) => {
  if (type === EventType.PRESS && detail.notification?.data) {
    setPendingNotificationPayload(detail.notification.data as Record<string, string>);
  }
};

/**
 * Register the Android background display and tap handlers.
 *
 * Called from index.js at module top level, BEFORE
 * AppRegistry.registerComponent — see the header for why it is a call and not
 * a side-effect import. Idempotent: a second call is a no-op, so an extra call
 * site cannot double-register the handlers (which would double-display).
 */
export function registerBackgroundPushHandlers(): void {
  if (registered) return;
  registered = true;

  // Create the Android notification channel eagerly at bundle load.
  // The background message handler (below) fires at JS bundle load time —
  // before auth and before initNotifications(). Displaying a notification
  // on a non-existent channel is silently dropped on Android.
  // This call is idempotent — calling it again in initNotifications() is harmless.
  notifee.createChannel(DEFAULT_CHANNEL);

  // Must be registered at module top-level BEFORE AppRegistry.registerComponent.
  // Without this, Android data-only push payloads are silently consumed when the
  // app is killed or backgrounded — no system notification appears.
  setBackgroundMessageHandler(getMessaging(), handleBackgroundMessage);

  // Must be registered at module top-level per Notifee docs.
  notifee.onBackgroundEvent(handleBackgroundEvent);
}
