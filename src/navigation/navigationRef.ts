/**
 * Global navigation ref for programmatic navigation from outside React components.
 *
 * Used by the notification tap handler to navigate to specific screens when the
 * user taps a push notification. Handles the killed-state cold-start race where
 * getInitialNotification resolves before the navigation tree mounts by queuing
 * the pending payload and flushing it from NavigationContainer's onReady callback.
 *
 * Also handles background-state taps where the nav tree IS ready — if a consumer
 * is registered and nav is ready, the payload is delivered immediately instead of
 * being queued.
 */

import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/**
 * Global navigation container ref — must be passed to NavigationContainer
 * in AppNavigator.tsx.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// ---------------------------------------------------------------------------
// Pending navigation for killed-state cold start
// ---------------------------------------------------------------------------

/**
 * When a notification tap arrives before the navigation tree is ready
 * (killed-state launch), we stash the payload here and flush it once
 * NavigationContainer fires onReady.
 */
let pendingPayload: Record<string, string> | null = null;

/** Callback type for the pending payload consumer. */
type PayloadConsumer = (data: Record<string, string>) => void;

/** The consumer function to call when flushing. Set by notificationService. */
let payloadConsumer: PayloadConsumer | null = null;

/**
 * Queue a notification payload for deferred navigation.
 * Called by notificationService when the nav tree is not ready yet,
 * or by index.js onBackgroundEvent.
 *
 * If a consumer is registered and navigation is already ready (background tap
 * scenario), the payload is delivered immediately rather than queued. This
 * handles the case where the app was backgrounded (nav already mounted) and
 * the user taps a notification — previously the payload sat in the queue
 * because onReady had already fired.
 */
export function setPendingNotificationPayload(data: Record<string, string>): void {
  if (payloadConsumer && navigationRef.isReady()) {
    payloadConsumer(data);
  } else {
    pendingPayload = data;
  }
}

/**
 * Register the function that should be called to navigate from a payload.
 * Called once by notificationService during setupNotificationTapHandler.
 */
export function setPayloadConsumer(consumer: PayloadConsumer): void {
  payloadConsumer = consumer;
}

/**
 * Flush any queued notification payload. Called from NavigationContainer's
 * onReady callback in AppNavigator.tsx.
 */
export function flushPendingNotificationPayload(): void {
  if (pendingPayload && payloadConsumer) {
    const data = pendingPayload;
    pendingPayload = null;
    payloadConsumer(data);
  }
}

/**
 * Reset module state. Exported for testing only.
 */
export function resetNavigationRefForTesting(): void {
  pendingPayload = null;
  payloadConsumer = null;
}
