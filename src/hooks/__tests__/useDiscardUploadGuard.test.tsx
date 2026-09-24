/**
 * Tests for useDiscardUploadGuard — arm conditions, alert copy (including noun
 * interpolation), Discard button ordering + action identity, discard-after-unmount
 * safety, one-shot latch, and Keep-then-re-invoke.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { NavigationAction } from '@react-navigation/routers';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUsePreventRemove = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  usePreventRemove: (preventRemove: boolean, cb: unknown) =>
    mockUsePreventRemove(preventRemove, cb),
  useNavigation: () => ({ dispatch: mockDispatch }),
}));

import {
  useDiscardUploadGuard,
  type UseDiscardUploadGuardOptions,
} from '../useDiscardUploadGuard';

// ---------------------------------------------------------------------------
// Alert helpers
// ---------------------------------------------------------------------------

interface AlertButton {
  text: string;
  style?: 'cancel' | 'destructive' | 'default';
  onPress?: () => void;
}

function getAlertButtons(
  alertSpy: jest.SpyInstance,
  callIndex = 0,
): AlertButton[] {
  const call = alertSpy.mock.calls[callIndex];
  if (!call) throw new Error(`No Alert.alert call at index ${callIndex}`);
  return call[2] as AlertButton[];
}

function getButton(buttons: AlertButton[], text: string): AlertButton {
  const btn = buttons.find((b) => b.text === text);
  if (!btn) {
    const found = buttons.map((b) => `"${b.text}"`).join(', ');
    throw new Error(`No button "${text}" — found: ${found}`);
  }
  return btn;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function Probe(props: UseDiscardUploadGuardOptions): null {
  useDiscardUploadGuard(props);
  return null;
}

function renderGuard(
  opts: UseDiscardUploadGuardOptions,
): ReturnType<typeof create> {
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(Probe, opts));
  });
  return root;
}

/**
 * Returns [preventRemove, callback] from the most recent usePreventRemove call.
 * The callback is re-registered on each render when its deps change, so we
 * always want the latest one.
 */
function getLastPreventRemoveArgs(): [
  boolean,
  (e: { data: { action: NavigationAction } }) => void,
] {
  const calls = mockUsePreventRemove.mock.calls;
  const last = calls[calls.length - 1];
  return [
    last[0] as boolean,
    last[1] as (e: { data: { action: NavigationAction } }) => void,
  ];
}

/** A fake action; the exact same reference is asserted inside dispatch. */
function makeAction(): NavigationAction {
  return { type: 'GO_BACK' } as unknown as NavigationAction;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const noopDiscard = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Arm conditions
// ---------------------------------------------------------------------------

describe('useDiscardUploadGuard — arm conditions', () => {
  it('is armed when uploading is true', () => {
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [preventRemove] = getLastPreventRemoveArgs();
    expect(preventRemove).toBe(true);
  });

  it('is armed when unsent is true', () => {
    renderGuard({ uploading: false, unsent: true, noun: 'post', onDiscard: noopDiscard });
    const [preventRemove] = getLastPreventRemoveArgs();
    expect(preventRemove).toBe(true);
  });

  it('is NOT armed when both uploading and unsent are false', () => {
    renderGuard({ uploading: false, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [preventRemove] = getLastPreventRemoveArgs();
    expect(preventRemove).toBe(false);
  });

  it('is NOT armed when uploading is false — a cancelling upload arrives as uploading=false', () => {
    // Screens pass `progress != null && !progress.cancelling` for `uploading`.
    // Once progress.cancelling is true the screen sends false; the guard must
    // not re-arm for something the user already asked to stop.
    renderGuard({ uploading: false, unsent: false, noun: 'reply', onDiscard: noopDiscard });
    const [preventRemove] = getLastPreventRemoveArgs();
    expect(preventRemove).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alert copy
// ---------------------------------------------------------------------------

describe('useDiscardUploadGuard — alert copy (uploading state)', () => {
  it('title is "Discard upload?", message mentions still uploading', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe('Discard upload?');
    expect(message).toContain('still uploading');
  });

  it('cancel button is labelled "Keep uploading" in the uploading state', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    expect(getButton(getAlertButtons(alertSpy), 'Keep uploading')).toBeDefined();
  });
});

describe('useDiscardUploadGuard — alert copy (unsent state)', () => {
  it('noun "reply": title is "Discard unsent reply?", message mentions attached media', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: false, unsent: true, noun: 'reply', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe('Discard unsent reply?');
    expect(message).toContain('attached media');
  });

  it('noun "post": title is "Discard unsent post?"', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: false, unsent: true, noun: 'post', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    const [title] = alertSpy.mock.calls[0] as [string];
    expect(title).toBe('Discard unsent post?');
  });

  it('noun "message": title is "Discard unsent message?"', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: false, unsent: true, noun: 'message', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    const [title] = alertSpy.mock.calls[0] as [string];
    expect(title).toBe('Discard unsent message?');
  });

  it('cancel button is labelled "Keep editing" in the unsent state', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: false, unsent: true, noun: 'reply', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();

    act(() => { cb({ data: { action: makeAction() } }); });

    expect(getButton(getAlertButtons(alertSpy), 'Keep editing')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Discard button — ordering and action identity
// ---------------------------------------------------------------------------

describe('useDiscardUploadGuard — Discard button', () => {
  it('calls onDiscard before dispatching, and dispatches the exact same action object', () => {
    const callOrder: string[] = [];
    const onDiscard = jest.fn(() => callOrder.push('discard'));
    mockDispatch.mockImplementation(() => callOrder.push('dispatch'));

    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard });
    const [, cb] = getLastPreventRemoveArgs();
    const action = makeAction();

    act(() => { cb({ data: { action } }); });
    getButton(getAlertButtons(alertSpy), 'Discard').onPress?.();

    // onDiscard runs before navigation.dispatch.
    expect(callOrder).toEqual(['discard', 'dispatch']);
    // The exact same action reference is dispatched (re-dispatching the same
    // object is how React Navigation lets the navigation through).
    expect(mockDispatch.mock.calls[0][0]).toBe(action);
  });

  it('dispatches with toBe identity (unsent state, different action object)', () => {
    const onDiscard = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: false, unsent: true, noun: 'reply', onDiscard });
    const [, cb] = getLastPreventRemoveArgs();
    const action = {
      type: 'NAVIGATE',
      payload: { name: 'Home' },
    } as unknown as NavigationAction;

    act(() => { cb({ data: { action } }); });
    getButton(getAlertButtons(alertSpy), 'Discard').onPress?.();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0]).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// Discard after unmount
// ---------------------------------------------------------------------------

describe('useDiscardUploadGuard — discard after unmount', () => {
  it('pressing Discard after the component unmounts calls neither onDiscard nor dispatch', () => {
    const onDiscard = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert');
    const root = renderGuard({
      uploading: true,
      unsent: false,
      noun: 'post',
      onDiscard,
    });
    const [, cb] = getLastPreventRemoveArgs();

    // Open the alert while the component is mounted.
    act(() => { cb({ data: { action: makeAction() } }); });

    // Unmount before the user presses Discard (e.g. the upload finished and
    // navigated away while the alert was visible).
    act(() => { root.unmount(); });

    getButton(getAlertButtons(alertSpy), 'Discard').onPress?.();

    expect(onDiscard).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One-shot latch
// ---------------------------------------------------------------------------

describe('useDiscardUploadGuard — one-shot latch', () => {
  it('invoking the callback twice without pressing a button shows exactly one alert', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();
    const action = makeAction();

    // First invocation opens the alert.
    act(() => { cb({ data: { action } }); });
    // Second invocation is no-op because the latch is held.
    act(() => { cb({ data: { action } }); });

    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('pressing Keep resets the latch so a subsequent callback invocation shows a second alert', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    renderGuard({ uploading: true, unsent: false, noun: 'post', onDiscard: noopDiscard });
    const [, cb] = getLastPreventRemoveArgs();
    const action = makeAction();

    // First press: open alert, then dismiss via Keep.
    act(() => { cb({ data: { action } }); });
    getButton(getAlertButtons(alertSpy, 0), 'Keep uploading').onPress?.();

    // Second press: latch was reset, so a new alert appears.
    act(() => { cb({ data: { action } }); });

    expect(alertSpy).toHaveBeenCalledTimes(2);
  });
});
