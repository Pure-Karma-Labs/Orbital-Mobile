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
  setBadgeCount: jest.fn().mockResolvedValue(undefined),
  onForegroundEvent: jest.fn().mockReturnValue(jest.fn()),
  onBackgroundEvent: jest.fn(),
};

export default notifee;

export const AndroidImportance = {
  DEFAULT: 3,
  HIGH: 4,
  LOW: 2,
  MIN: 1,
  NONE: 0,
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
