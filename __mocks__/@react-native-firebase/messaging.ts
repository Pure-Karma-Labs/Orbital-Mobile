/**
 * Manual mock for @react-native-firebase/messaging (modular API, v26 shape:
 * no default export).
 *
 * Parity contract (#667): every export is declared as
 * `jest.MockedFunction<typeof RNFBMessaging.<fn>>` AND constructed with
 * explicit generics, so `tsc --noEmit` fails when the real module removes or
 * renames an export (the `typeof` lookup breaks) OR when a signature the app
 * relies on changes (the generic return/params no longer line up). A bare
 * `jest.fn()` is `Mock<any, any>` and would only give existence detection —
 * do not drop the generics. `import type` is erased at runtime, so nothing
 * native is loaded.
 */
import type * as RNFBMessaging from '@react-native-firebase/messaging';

/** Opaque instance handle; the app never reads its properties. */
const messagingInstance = {} as RNFBMessaging.Messaging;

export const getMessaging: jest.MockedFunction<typeof RNFBMessaging.getMessaging> =
  jest.fn<ReturnType<typeof RNFBMessaging.getMessaging>, Parameters<typeof RNFBMessaging.getMessaging>>(() => messagingInstance);
export const getToken: jest.MockedFunction<typeof RNFBMessaging.getToken> =
  jest.fn<ReturnType<typeof RNFBMessaging.getToken>, Parameters<typeof RNFBMessaging.getToken>>().mockResolvedValue('mock-fcm-token');
export const onTokenRefresh: jest.MockedFunction<typeof RNFBMessaging.onTokenRefresh> =
  jest.fn<ReturnType<typeof RNFBMessaging.onTokenRefresh>, Parameters<typeof RNFBMessaging.onTokenRefresh>>().mockReturnValue(jest.fn()); // returns unsubscribe
export const onMessage: jest.MockedFunction<typeof RNFBMessaging.onMessage> =
  jest.fn<ReturnType<typeof RNFBMessaging.onMessage>, Parameters<typeof RNFBMessaging.onMessage>>().mockReturnValue(jest.fn()); // returns unsubscribe
export const onNotificationOpenedApp: jest.MockedFunction<typeof RNFBMessaging.onNotificationOpenedApp> =
  jest.fn<ReturnType<typeof RNFBMessaging.onNotificationOpenedApp>, Parameters<typeof RNFBMessaging.onNotificationOpenedApp>>().mockReturnValue(jest.fn()); // returns unsubscribe
export const getInitialNotification: jest.MockedFunction<typeof RNFBMessaging.getInitialNotification> =
  jest.fn<ReturnType<typeof RNFBMessaging.getInitialNotification>, Parameters<typeof RNFBMessaging.getInitialNotification>>().mockResolvedValue(null);
// Registered at bundle load in index.js (background push display path).
export const setBackgroundMessageHandler: jest.MockedFunction<typeof RNFBMessaging.setBackgroundMessageHandler> =
  jest.fn<ReturnType<typeof RNFBMessaging.setBackgroundMessageHandler>, Parameters<typeof RNFBMessaging.setBackgroundMessageHandler>>();
