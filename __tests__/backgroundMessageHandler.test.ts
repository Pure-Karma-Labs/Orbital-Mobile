/**
 * Tests for the background push display path registered in index.js.
 *
 * Covers #449 D9 (per-thread collapse) on the background handler: the tray
 * entry id and onlyAlertOnce, and the invariant that the background handler
 * performs NO preference/mute filtering (it runs pre-bootstrap with no access
 * to encrypted MMKV — suppression there is server-side only).
 */

import notifee from '@notifee/react-native';
import messaging from '@react-native-firebase/messaging';

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

type BackgroundHandler = (msg: { data?: Record<string, string> }) => Promise<void>;

/** Load index.js once and return its registered background message handler. */
function getBackgroundHandler(): BackgroundHandler {
  require('../index');
  const setHandler = (messaging() as unknown as {
    setBackgroundMessageHandler: jest.Mock;
  }).setBackgroundMessageHandler;
  return setHandler.mock.calls[0][0] as BackgroundHandler;
}

let handler: BackgroundHandler;

beforeAll(() => {
  handler = getBackgroundHandler();
});

beforeEach(() => {
  (notifee.displayNotification as jest.Mock).mockClear();
});

/** Last displayNotification argument. */
function lastDisplayArg(): Record<string, unknown> {
  const calls = (notifee.displayNotification as jest.Mock).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

describe('background message handler — collapse (#449 D9)', () => {
  it('collapses new_reply on tid and sets onlyAlertOnce', async () => {
    await handler({ data: { t: 'new_reply', gid: 'g1', tid: 'bg-thread-1', rid: 'bg-r1' } });

    const arg = lastDisplayArg();
    expect(arg.id).toBe('bg-thread-1');
    expect((arg.android as Record<string, unknown>).onlyAlertOnce).toBe(true);
  });

  it('collapses new_dm on gid', async () => {
    await handler({ data: { t: 'new_dm', gid: 'bg-conv-1' } });

    expect(lastDisplayArg().id).toBe('bg-conv-1');
  });

  it('omits the id entirely for identity_key_reset — security alerts must stack', async () => {
    await handler({ data: { t: 'identity_key_reset', v: '1' } });

    const arg = lastDisplayArg();
    expect('id' in arg).toBe(false);
    expect(arg.title).toBe('Security alert');
    // onlyAlertOnce is harmless here: each alert has a distinct auto id, so
    // they still stack.
    expect((arg.android as Record<string, unknown>).onlyAlertOnce).toBe(true);
  });

  it('displays without an id when the collapse key is missing', async () => {
    await handler({ data: { t: 'new_thread', gid: 'g1' } });

    expect('id' in lastDisplayArg()).toBe(false);
  });

  it('does not filter on preferences or mutes — background suppression is server-side', async () => {
    // No store/MMKV access exists at this point in the lifecycle, so every
    // payload with a known type displays.
    await handler({ data: { t: 'member_joined', gid: 'bg-group-77' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
    expect(lastDisplayArg().id).toBe('bg-group-77');
  });

  it('ignores payloads with no type', async () => {
    await handler({ data: {} });

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('dedups repeated events', async () => {
    await handler({ data: { t: 'new_reply', tid: 'bg-thread-9', rid: 'bg-r9' } });
    await handler({ data: { t: 'new_reply', tid: 'bg-thread-9', rid: 'bg-r9' } });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });
});
