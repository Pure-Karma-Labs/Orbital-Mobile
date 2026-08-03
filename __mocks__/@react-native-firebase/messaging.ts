/**
 * Manual mock for @react-native-firebase/messaging.
 *
 * Provides a mock messaging() function with the methods used by
 * notificationService.ts. Each method is a jest.fn() so tests can
 * configure return values and assert calls.
 */

const messagingInstance = {
  getToken: jest.fn().mockResolvedValue('mock-fcm-token'),
  onTokenRefresh: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  onMessage: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  onNotificationOpenedApp: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  getInitialNotification: jest.fn().mockResolvedValue(null),
  deleteToken: jest.fn().mockResolvedValue(undefined),
  // Registered at bundle load in index.js (background push display path).
  setBackgroundMessageHandler: jest.fn(),
};

const messaging = Object.assign(jest.fn(() => messagingInstance), {
  AuthorizationStatus: {
    NOT_DETERMINED: -1 as const,
    DENIED: 0 as const,
    AUTHORIZED: 1 as const,
    PROVISIONAL: 2 as const,
  },
});

export default messaging;
