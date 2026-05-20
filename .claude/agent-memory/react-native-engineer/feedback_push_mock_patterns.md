---
name: push-mock-patterns
description: Jest mock patterns for Firebase Messaging and Notifee — Object.assign for static properties on mock functions, EventType export, SettingsScreen must mock useNotifications
metadata:
  type: feedback
---

Mock Firebase Messaging with `Object.assign(jest.fn(...), { AuthorizationStatus: ... })` to attach static enum properties to the callable mock function. A plain jest.fn + property assignment doesn't work because jest.fn returns a different type.

File: `__mocks__/@react-native-firebase/messaging.ts`

Mock Notifee must export `EventType` and `AndroidImportance` as named exports alongside the default mock object. Must include: onForegroundEvent, onBackgroundEvent, getBadgeCount, setBadgeCount, getChannels, createChannel, displayNotification, getInitialNotification.

File: `__mocks__/@notifee/react-native.ts`

SettingsScreen tests must mock `useNotifications` hook when the notification slice is integrated into the store — the screen reads push permission state for display.

**Why:** Firebase Messaging uses `messaging.AuthorizationStatus.AUTHORIZED` (static property on the function itself). Standard mock patterns lose these statics. Notifee EventType is used in switch statements so tests fail if the export is missing.

**How to apply:** When adding new push-related features, ensure mocks stay in sync. When testing any screen that reads notification state, verify the mock covers the notification slice.

Related: [[push-notifications]]
