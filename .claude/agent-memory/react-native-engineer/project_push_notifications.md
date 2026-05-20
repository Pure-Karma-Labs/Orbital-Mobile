---
name: push-notifications
description: Firebase Cloud Messaging + Notifee push notification architecture — permission flow, token lifecycle, foreground display, tap navigation with cold-start queuing, background handlers in index.js
metadata:
  type: project
---

Push notification stack: Firebase Cloud Messaging (transport) + Notifee (local display + event handling).

**Key files:**
- `src/services/notificationService.ts` — public API: initNotifications, requestPermissionAndRegister, deregisterCurrentDevice, setupForegroundHandler, setupNotificationTapHandler
- `src/services/deviceId.ts` — MMKV-persisted stable UUID via getDeviceId(); must be called lazily (MMKV not ready at module scope)
- `src/stores/slices/notificationSlice.ts` — pushPermissionGranted (boolean), pushToken (string|null), actions: setPushPermission, setPushToken
- `src/navigation/navigationRef.ts` — global nav ref (createNavigationContainerRef) + cold-start payload queue: setPendingNotificationPayload, setPayloadConsumer, flushPendingNotificationPayload
- `index.js` — setBackgroundMessageHandler + onBackgroundEvent MUST be at module top-level before AppRegistry.registerComponent

**Permission and registration flow:**
1. `initNotifications()` — creates Android channel, checks Notifee native module availability
2. `requestPermissionAndRegister()` — requests FCM permission, gets token, calls `registerDevice()` API, starts `onTokenRefresh` listener
3. Returns unsubscribe for onTokenRefresh — must be cleaned up in App.tsx effect on logout to prevent listener leak

**Foreground display:**
- `setupForegroundHandler()` uses `messaging().onMessage` + `notifee.displayNotification()`
- If Notifee unavailable (New Architecture edge case), foreground messages silently consumed — user sees content via WebSocket
- iOS badge incremented on foreground notification; cleared on AppState 'active' transition

**Three notification tap sources:**
1. Foreground tap — Notifee `onForegroundEvent` with EventType.PRESS
2. Background tap — `onBackgroundEvent` in index.js queues payload via setPendingNotificationPayload
3. Killed-state tap — `messaging().getInitialNotification()` (one-shot)

**Cold-start race condition:**
- getInitialNotification can resolve before NavigationContainer mounts
- Solution: payload queued in module-scoped variable, flushed from NavigationContainer's onReady callback via flushPendingNotificationPayload()
- navigateFromNotification checks navigationRef.isReady(); if not ready, queues payload

**Security:**
- Push payloads are content-free event signals (type + IDs only, no message content)
- Raw FCM/APNs tokens never logged
- deregisterCurrentDevice() is best-effort on logout — never blocks the logout flow

**Why:** Push enables real-time engagement without polling. Content-free payloads avoid leaking encrypted data through push infrastructure.

**How to apply:** All notification setup runs after auth succeeds (App.tsx useEffect on isAuthenticated). Cleanup all listeners on logout. Background handlers must stay in index.js at top level.

Related: [[navigation-and-auth-gate]], [[bootstrap-and-init]]
