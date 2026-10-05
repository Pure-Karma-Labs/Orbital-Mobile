/**
 * Wiring and ORDER test for the background push path in index.js (#771).
 *
 * This suite deliberately tests no display behaviour — that moved to
 * src/services/__tests__/backgroundPush.test.ts, which calls the typed
 * handlers directly. What only index.js can tell us is:
 *
 * 1. the handlers RNFB and notifee received are the exported ones (identity,
 *    not shape — a shape assertion would pass against a stale copy), and
 * 2. registration happens BEFORE AppRegistry.registerComponent. Android
 *    data-only payloads are silently consumed when the app is killed or
 *    backgrounded if the background message handler is registered late, and
 *    the Android channel must exist before the first displayNotification or
 *    the notification is dropped without error.
 *
 * It CANNOT detect a conversion of the explicit registerBackgroundPushHandlers()
 * call back into a side-effect `import` — Jest does not apply Metro's
 * inlineRequires, so both forms run at the same point here. That reason is
 * recorded in code instead: see the index.js call-site comment and the
 * backgroundPush.ts module header.
 */

import { AppRegistry } from 'react-native';
import notifee from '@notifee/react-native';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';

import { handleBackgroundMessage, handleBackgroundEvent } from '../src/services/backgroundPush';

// index.js pulls in the whole app tree at bundle load; stub the pieces that
// need native modules or a React renderer.
jest.mock('../src/App', () => ({ __esModule: true, default: () => null }));
jest.mock('../src/sentryInit', () => ({}));
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native-gesture-handler', () => ({}));
jest.mock('react-native-screens', () => ({ enableScreens: jest.fn() }));
jest.mock('../src/navigation/navigationRef', () => ({
  setPendingNotificationPayload: jest.fn(),
}));

let registerComponentSpy: jest.SpyInstance;

beforeAll(() => {
  registerComponentSpy = jest
    .spyOn(AppRegistry, 'registerComponent')
    .mockImplementation(((name: string) => name) as never);
  require('../index');
});

afterAll(() => {
  registerComponentSpy.mockRestore();
});

describe('index.js background push wiring', () => {
  it('registers the exported background message handler with the messaging instance', () => {
    expect(setBackgroundMessageHandler).toHaveBeenCalledTimes(1);
    expect(setBackgroundMessageHandler).toHaveBeenCalledWith(
      (getMessaging as jest.Mock).mock.results[0].value,
      handleBackgroundMessage,
    );
  });

  it('registers the exported background event handler with notifee', () => {
    expect(notifee.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(notifee.onBackgroundEvent).toHaveBeenCalledWith(handleBackgroundEvent);
  });

  it('creates the channel and both handlers before AppRegistry.registerComponent', () => {
    const order = (mock: jest.Mock | jest.SpyInstance): number =>
      (mock as jest.Mock).mock.invocationCallOrder[0];

    const channel = order(notifee.createChannel as jest.Mock);
    const message = order(setBackgroundMessageHandler as unknown as jest.Mock);
    const event = order(notifee.onBackgroundEvent as jest.Mock);
    const register = order(registerComponentSpy);

    expect(channel).toBeLessThan(message);
    expect(message).toBeLessThan(event);
    expect(event).toBeLessThan(register);
  });
});
