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

type Fn<K extends keyof typeof RNFBMessaging> = (typeof RNFBMessaging)[K] extends (
  ...args: infer P
) => infer R
  ? { params: P; ret: R }
  : never;

/** Opaque instance handle; the app never reads its properties. */
const messagingInstance = {} as RNFBMessaging.Messaging;

export const getMessaging: jest.MockedFunction<typeof RNFBMessaging.getMessaging> =
  jest.fn<Fn<'getMessaging'>['ret'], Fn<'getMessaging'>['params']>(() => messagingInstance);
export const getToken: jest.MockedFunction<typeof RNFBMessaging.getToken> =
  jest.fn<Fn<'getToken'>['ret'], Fn<'getToken'>['params']>().mockResolvedValue('mock-fcm-token');
export const onTokenRefresh: jest.MockedFunction<typeof RNFBMessaging.onTokenRefresh> =
  jest.fn<Fn<'onTokenRefresh'>['ret'], Fn<'onTokenRefresh'>['params']>().mockReturnValue(jest.fn()); // returns unsubscribe
export const onMessage: jest.MockedFunction<typeof RNFBMessaging.onMessage> =
  jest.fn<Fn<'onMessage'>['ret'], Fn<'onMessage'>['params']>().mockReturnValue(jest.fn()); // returns unsubscribe
export const onNotificationOpenedApp: jest.MockedFunction<typeof RNFBMessaging.onNotificationOpenedApp> =
  jest.fn<Fn<'onNotificationOpenedApp'>['ret'], Fn<'onNotificationOpenedApp'>['params']>().mockReturnValue(jest.fn()); // returns unsubscribe
export const getInitialNotification: jest.MockedFunction<typeof RNFBMessaging.getInitialNotification> =
  jest.fn<Fn<'getInitialNotification'>['ret'], Fn<'getInitialNotification'>['params']>().mockResolvedValue(null);
// Registered at bundle load in index.js (background push display path).
export const setBackgroundMessageHandler: jest.MockedFunction<typeof RNFBMessaging.setBackgroundMessageHandler> =
  jest.fn<Fn<'setBackgroundMessageHandler'>['ret'], Fn<'setBackgroundMessageHandler'>['params']>();
