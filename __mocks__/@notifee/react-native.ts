/**
 * Manual mock for @notifee/react-native.
 *
 * Provides the methods used by notificationService.ts. Foreground
 * display, channel creation, and initial notification are mocked.
 */

const notifee = {
  createChannel: jest.fn().mockResolvedValue('orbital-default'),
  displayNotification: jest.fn().mockResolvedValue('mock-notification-id'),
  getInitialNotification: jest.fn().mockResolvedValue(null),
  cancelNotification: jest.fn().mockResolvedValue(undefined),
  getBadgeCount: jest.fn().mockResolvedValue(0),
  setBadgeCount: jest.fn().mockResolvedValue(undefined),
  getChannels: jest.fn().mockResolvedValue([]),
  onForegroundEvent: jest.fn().mockReturnValue(jest.fn()),
  onBackgroundEvent: jest.fn(),
  requestPermission: jest.fn().mockResolvedValue({ authorizationStatus: 1 }),
  getNotificationSettings: jest.fn().mockResolvedValue({ authorizationStatus: 1, android: {}, ios: {} }),
};

export default notifee;

export const AndroidImportance = {
  DEFAULT: 3,
  HIGH: 4,
  LOW: 2,
  MIN: 1,
  NONE: 0,
};

export const AuthorizationStatus = {
  NOT_DETERMINED: -1 as const,
  DENIED: 0 as const,
  AUTHORIZED: 1 as const,
  PROVISIONAL: 2 as const,
};

export const EventType = {
  DISMISSED: 0,
  PRESS: 1,
  ACTION_PRESS: 2,
  DELIVERED: 3,
  APP_BLOCKED: 4,
  CHANNEL_BLOCKED: 5,
  CHANNEL_GROUP_BLOCKED: 6,
  TRIGGER_NOTIFICATION_CREATED: 7,
};
