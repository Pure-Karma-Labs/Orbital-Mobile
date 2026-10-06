/**
 * Behaviour tests for the background push path (src/services/backgroundPush.ts).
 *
 * Covers #449 D9 (per-thread collapse) on the background display handler — the
 * tray entry id and onlyAlertOnce — plus the invariant that the background
 * handler performs NO preference/mute filtering (it runs pre-bootstrap with no
 * access to encrypted MMKV; suppression there is server-side only), the tap
 * handler, and the shared display builder.
 *
 * Wiring and ordering (channel before handler before registerComponent) live
 * in __tests__/backgroundPushWiring.test.ts, which requires index.js.
 *
 * DEDUP KEYS MUST BE UNIQUE ACROSS THIS FILE. `bgDedupSet` is module-level
 * state in backgroundPush.ts and there is deliberately no reset export: the
 * real set must survive for the whole headless JS lifetime, and an exported
 * reset would be a production-reachable way to defeat dedup. Reusing a
 * tid/rid pair between cases would therefore make the second case silently
 * display nothing.
 */

import notifee from '@notifee/react-native';
import { setBackgroundMessageHandler, getMessaging } from '@react-native-firebase/messaging';

import { setPendingNotificationPayload } from '../../navigation/navigationRef';
import {
  handleBackgroundMessage,
  handleBackgroundEvent,
  registerBackgroundPushHandlers,
} from '../backgroundPush';
import { DEFAULT_CHANNEL, buildNotificationRequest } from '../notificationConstants';

jest.mock('../../navigation/navigationRef', () => ({
  setPendingNotificationPayload: jest.fn(),
}));

/** EventType.PRESS / DISMISSED from the notifee mock. */
const PRESS = 1;
const DISMISSED = 0;

beforeEach(() => {
  (notifee.displayNotification as jest.Mock).mockClear();
  (setPendingNotificationPayload as jest.Mock).mockClear();
});

/** Last displayNotification argument. */
function lastDisplayArg(): Record<string, unknown> {
  const calls = (notifee.displayNotification as jest.Mock).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

/** Call the typed handler with a data-only payload. */
function display(data: Record<string, string>): Promise<unknown> {
  // The RNFB RemoteMessage type carries more fields than the handler reads.
  return handleBackgroundMessage({ data } as Parameters<typeof handleBackgroundMessage>[0]);
}

describe('handleBackgroundMessage — collapse (#449 D9)', () => {
  it('collapses new_reply on tid and sets onlyAlertOnce', async () => {
    await display({ t: 'new_reply', gid: 'g1', tid: 'bg-thread-1', rid: 'bg-r1' });

    const arg = lastDisplayArg();
    expect(arg.id).toBe('bg-thread-1');
    expect((arg.android as Record<string, unknown>).onlyAlertOnce).toBe(true);
  });

  it('collapses new_dm on gid', async () => {
    await display({ t: 'new_dm', gid: 'bg-conv-1' });

    expect(lastDisplayArg().id).toBe('bg-conv-1');
  });

  it('omits the id entirely for identity_key_reset — security alerts must stack', async () => {
    await display({ t: 'identity_key_reset', v: '1' });

    const arg = lastDisplayArg();
    expect('id' in arg).toBe(false);
    expect(arg.title).toBe('Security alert');
    // onlyAlertOnce is harmless here: each alert has a distinct auto id, so
    // they still stack.
    expect((arg.android as Record<string, unknown>).onlyAlertOnce).toBe(true);
  });

  it('displays without an id when the collapse key is missing', async () => {
    await display({ t: 'new_thread', gid: 'g1' });

    expect('id' in lastDisplayArg()).toBe(false);
  });

  it('does not filter on preferences or mutes — background suppression is server-side', async () => {
    // No store/MMKV access exists at this point in the lifecycle, so every
    // payload with a known type displays.
    await display({ t: 'member_joined', gid: 'bg-group-77' });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
    expect(lastDisplayArg().id).toBe('bg-group-77');
  });

  it('ignores payloads with no type', async () => {
    await display({});

    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('dedups repeated events', async () => {
    await display({ t: 'new_reply', tid: 'bg-thread-9', rid: 'bg-r9' });
    await display({ t: 'new_reply', tid: 'bg-thread-9', rid: 'bg-r9' });

    expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  });
});

describe('handleBackgroundEvent — background/killed-state tap', () => {
  it('queues the payload for deferred navigation on PRESS', async () => {
    const data = { t: 'new_reply', tid: 'bg-tap-1', rid: 'bg-tap-r1' };

    await handleBackgroundEvent({
      type: PRESS,
      detail: { notification: { data } },
    } as Parameters<typeof handleBackgroundEvent>[0]);

    expect(setPendingNotificationPayload).toHaveBeenCalledWith(data);
  });

  it('ignores non-PRESS events', async () => {
    await handleBackgroundEvent({
      type: DISMISSED,
      detail: { notification: { data: { t: 'new_reply', tid: 'bg-tap-2' } } },
    } as Parameters<typeof handleBackgroundEvent>[0]);

    expect(setPendingNotificationPayload).not.toHaveBeenCalled();
  });

  it('ignores a PRESS with no payload', async () => {
    await handleBackgroundEvent({
      type: PRESS,
      detail: { notification: {} },
    } as Parameters<typeof handleBackgroundEvent>[0]);

    expect(setPendingNotificationPayload).not.toHaveBeenCalled();
  });
});

describe('registerBackgroundPushHandlers — idempotence', () => {
  it('registers once; a second call is a no-op', () => {
    // index.js is not required by this suite, so the first call here is the
    // first registration in this module registry.
    registerBackgroundPushHandlers();
    registerBackgroundPushHandlers();

    expect(notifee.createChannel).toHaveBeenCalledTimes(1);
    // The shared channel constant, not a local literal.
    expect(notifee.createChannel).toHaveBeenCalledWith(DEFAULT_CHANNEL);
    expect(setBackgroundMessageHandler).toHaveBeenCalledTimes(1);
    expect(notifee.onBackgroundEvent).toHaveBeenCalledTimes(1);
    // Identity, not shape: the exported handlers are what got registered.
    expect(setBackgroundMessageHandler).toHaveBeenCalledWith(
      (getMessaging as jest.Mock).mock.results[0].value,
      handleBackgroundMessage,
    );
    expect(notifee.onBackgroundEvent).toHaveBeenCalledWith(handleBackgroundEvent);
  });
});

describe('buildNotificationRequest', () => {
  it('builds the full display request with a collapse id', () => {
    const data = { t: 'new_reply', tid: 't1', rid: 'r1' };

    expect(buildNotificationRequest(data, 'New reply in a thread', 't1')).toEqual({
      title: 'New reply in a thread',
      body: 'Tap to view',
      data,
      id: 't1',
      android: {
        channelId: 'orbital-default',
        smallIcon: 'ic_notification',
        importance: 4, // AndroidImportance.HIGH
        pressAction: { id: 'default' },
        onlyAlertOnce: true,
      },
    });
  });

  it('omits the id key entirely when there is no collapse key', () => {
    const request = buildNotificationRequest({ t: 'identity_key_reset' }, 'Security alert', null);

    // Not `id: undefined` — notifee must assign a fresh id so alerts stack.
    expect('id' in request).toBe(false);
  });

  it('targets the channel this app actually creates', () => {
    // The drift that silently drops Android notifications: a request posted to
    // a channelId that createChannel never created.
    const android = buildNotificationRequest({ t: 'new_dm', gid: 'g1' }, 'New direct message', 'g1')
      .android as Record<string, unknown>;

    expect(android.channelId).toBe(DEFAULT_CHANNEL.id);
    expect(DEFAULT_CHANNEL).toEqual({ id: 'orbital-default', name: 'Orbital', importance: 4 });
  });

  it('passes the payload through unchanged as the notification data', () => {
    const data = { t: 'new_dm', gid: 'g9' };

    expect(buildNotificationRequest(data, 'New direct message', 'g9').data).toBe(data);
  });
});
