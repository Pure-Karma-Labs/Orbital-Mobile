/**
 * Tests for confirmUnblock — the one unblock confirmation (#908).
 *
 * The copy and button shape are the contract: BlockedUsersScreen and the in-DM
 * BlockedPeerNotice both call this, so a wording or ordering change here would
 * silently change both. The Unblock button must go through
 * `unblockUserAndRefresh` (#897) with the user id, never the slice action.
 */

import { Alert } from 'react-native';
import { confirmUnblock } from '../confirmUnblock';

const mockUnblockUserAndRefresh = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('../../services/blockedContentRefresh', () => ({
  unblockUserAndRefresh: (userId: string) => mockUnblockUserAndRefresh(userId),
}));

interface AlertButton {
  text: string;
  style?: string;
  onPress?: () => void;
}

function getButtons(alertSpy: jest.SpyInstance): AlertButton[] {
  const call = alertSpy.mock.calls[0];
  if (!call) throw new Error('Alert.alert was not called');
  return call[2] as AlertButton[];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('confirmUnblock — the alert', () => {
  it('opens one alert with the exact title and body', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('u-1', '@alice');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Unblock @alice?');
    expect(alertSpy.mock.calls[0][1]).toBe('You will see their posts and replies again.');
  });

  it('never composes an @ — it titles with the label it was given', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('abcdef0123456789', 'user-abcdef01');

    expect(alertSpy.mock.calls[0][0]).toBe('Unblock user-abcdef01?');
  });

  it('offers exactly Cancel (cancel style) then Unblock', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('u-1', '@alice');

    const buttons = getButtons(alertSpy);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toBe('Cancel');
    expect(buttons[0].style).toBe('cancel');
    expect(buttons[0].onPress).toBeUndefined();
    expect(buttons[1].text).toBe('Unblock');
    expect(buttons[1].style).toBeUndefined();
    expect(typeof buttons[1].onPress).toBe('function');
  });
});

describe('confirmUnblock — confirming', () => {
  it('calls unblockUserAndRefresh with the user id when Unblock is pressed', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('u-1', '@alice');
    getButtons(alertSpy)[1].onPress?.();

    expect(mockUnblockUserAndRefresh).toHaveBeenCalledTimes(1);
    expect(mockUnblockUserAndRefresh).toHaveBeenCalledWith('u-1');
  });

  it('does not unblock until the Unblock button is pressed', () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('u-1', '@alice');

    expect(mockUnblockUserAndRefresh).not.toHaveBeenCalled();
  });

  it('does not unblock when Cancel is pressed', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    confirmUnblock('u-1', '@alice');
    getButtons(alertSpy)[0].onPress?.();

    expect(mockUnblockUserAndRefresh).not.toHaveBeenCalled();
  });

  it('returns void synchronously and does not await the unblock', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockUnblockUserAndRefresh.mockReturnValueOnce(new Promise<void>(() => {}));

    expect(confirmUnblock('u-1', '@alice')).toBeUndefined();
    expect(() => getButtons(alertSpy)[1].onPress?.()).not.toThrow();
    expect(mockUnblockUserAndRefresh).toHaveBeenCalledWith('u-1');
  });
});
