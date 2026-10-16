/**
 * Tests for BlockedPeerNotice — the shared "You blocked {label}" + Unblock row
 * shown where a DM composer or empty state would otherwise invite sending to a
 * blocked peer (#908).
 *
 * The notice is the DM-side half of the pair whose copy must match
 * BlockedUsersScreen, so the confirmation it opens is asserted end to end: tap
 * Unblock -> the shared `confirmUnblock` alert -> `unblockUserAndRefresh(peerId)`
 * (#897). `confirmUnblock` is deliberately NOT mocked here; only the service
 * underneath it is, so a drift between the notice and the shared confirmation
 * fails this suite.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { BlockedPeerNotice } from '../BlockedPeerNotice';

const mockUnblockUserAndRefresh = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('../../services/blockedContentRefresh', () => ({
  unblockUserAndRefresh: (userId: string) => mockUnblockUserAndRefresh(userId),
}));

interface AlertButton {
  text: string;
  style?: string;
  onPress?: () => void;
}

function render(props: React.ComponentProps<typeof BlockedPeerNotice>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(BlockedPeerNotice, props),
      ),
    );
  });
  return renderer;
}

function getButtons(alertSpy: jest.SpyInstance): AlertButton[] {
  const call = alertSpy.mock.calls[0];
  if (!call) throw new Error('Alert.alert was not called');
  return call[2] as AlertButton[];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BlockedPeerNotice — rendering', () => {
  it('renders the notice text with the label', () => {
    const tree = render({ label: '@alice', peerId: 'u-1' });
    expect(JSON.stringify(tree.toJSON())).toContain('You blocked');
    expect(JSON.stringify(tree.toJSON())).toContain('@alice');
  });

  it('uses the default testID and exposes the unblock control', () => {
    const tree = render({ label: '@alice', peerId: 'u-1' });
    expect(tree.root.findByProps({ testID: 'blocked-peer-notice' })).toBeDefined();
    expect(tree.root.findByProps({ testID: 'blocked-peer-unblock' })).toBeDefined();
  });

  it('honours an overridden testID', () => {
    const tree = render({
      label: '@alice',
      peerId: 'u-1',
      testID: 'chat-blocked-peer-notice',
    });
    expect(tree.root.findByProps({ testID: 'chat-blocked-peer-notice' })).toBeDefined();
    // The control's testID is fixed, so callers can always find it.
    expect(tree.root.findByProps({ testID: 'blocked-peer-unblock' })).toBeDefined();
  });

  it('renders an unresolved id label verbatim, without adding an @', () => {
    const tree = render({ label: 'user-abcdef01', peerId: 'abcdef0123456789' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('user-abcdef01');
    expect(json).not.toContain('@user-abcdef01');
  });
});

describe('BlockedPeerNotice — accessibility', () => {
  it('labels the notice text with the full sentence', () => {
    const tree = render({ label: '@alice', peerId: 'u-1' });
    const notice = tree.root.findByProps({ testID: 'blocked-peer-notice' });
    const labelled = notice.findByProps({ accessibilityLabel: 'You blocked @alice' });
    expect(labelled).toBeDefined();
  });

  it('labels the unblock control as a button naming the peer', () => {
    const tree = render({ label: '@alice', peerId: 'u-1' });
    const control = tree.root.findByProps({ testID: 'blocked-peer-unblock' });
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('Unblock @alice');
  });
});

describe('BlockedPeerNotice — unblocking', () => {
  it('opens the shared confirmation with the exact copy when Unblock is tapped', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = render({ label: '@alice', peerId: 'u-1' });

    act(() => {
      tree.root.findByProps({ testID: 'blocked-peer-unblock' }).props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Unblock @alice?');
    expect(alertSpy.mock.calls[0][1]).toBe('You will see their posts and replies again.');
    const buttons = getButtons(alertSpy);
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Unblock']);
    expect(buttons[0].style).toBe('cancel');
  });

  it('unblocks the peer id when the confirmation is accepted', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = render({ label: '@alice', peerId: 'u-1' });

    act(() => {
      tree.root.findByProps({ testID: 'blocked-peer-unblock' }).props.onPress();
    });
    act(() => {
      getButtons(alertSpy)[1].onPress?.();
    });

    expect(mockUnblockUserAndRefresh).toHaveBeenCalledTimes(1);
    expect(mockUnblockUserAndRefresh).toHaveBeenCalledWith('u-1');
  });

  it('does not unblock on the tap alone, nor on Cancel', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = render({ label: '@alice', peerId: 'u-1' });

    act(() => {
      tree.root.findByProps({ testID: 'blocked-peer-unblock' }).props.onPress();
    });
    expect(mockUnblockUserAndRefresh).not.toHaveBeenCalled();

    act(() => {
      getButtons(alertSpy)[0].onPress?.();
    });
    expect(mockUnblockUserAndRefresh).not.toHaveBeenCalled();
  });
});
