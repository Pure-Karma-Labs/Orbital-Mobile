/**
 * Manual mock for @react-native-firebase/messaging.
 *
 * Provides a mock messaging() function with the methods used by
 * notificationService.ts. Each method is a jest.fn() so tests can
 * configure return values and assert calls.
 */

const messagingInstance = {
  requestPermission: jest.fn().mockResolvedValue(1), // AUTHORIZED
  getToken: jest.fn().mockResolvedValue('mock-fcm-token'),
  onTokenRefresh: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  onMessage: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  onNotificationOpenedApp: jest.fn().mockReturnValue(jest.fn()), // returns unsubscribe
  getInitialNotification: jest.fn().mockResolvedValue(null),
  deleteToken: jest.fn().mockResolvedValue(undefined),
  hasPermission: jest.fn().mockResolvedValue(1), // AUTHORIZED
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
