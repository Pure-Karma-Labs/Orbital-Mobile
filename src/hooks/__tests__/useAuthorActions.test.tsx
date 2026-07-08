/**
 * Tests for useAuthorActions — the shared block/report action-sheet chain
 * used by ThreadHeader, ReplyItem, and ChatMessageItem author rows.
 *
 * Covers:
 * - No-op when the author is the current user
 * - Top-level action alert (Block / Report / Cancel)
 * - Block confirm chain -> blockUser -> "Also report?" follow-up
 * - Follow-up Report -> openReportSheet with content context
 * - handleReport with/without a content context
 * - Cancel path does not call blockUser or openReportSheet
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { useAuthorActions, type AuthorActionContext } from '../useAuthorActions';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockBlockUser = jest.fn();
const mockOpenReportSheet = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      blockUser: mockBlockUser,
      openReportSheet: mockOpenReportSheet,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Probe — mounts the hook via a component so it can use React hooks, and
// exposes the returned actions to the test via a module-level capture.
// ---------------------------------------------------------------------------

type Actions = ReturnType<typeof useAuthorActions>;

let capturedActions: Actions | null = null;

function Probe(props: {
  authorId: string;
  authorUsername: string;
  currentUserId: string | null;
  context?: AuthorActionContext;
}): null {
  capturedActions = useAuthorActions(
    props.authorId,
    props.authorUsername,
    props.currentUserId,
    props.context,
  );
  return null;
}

function renderActions(props: {
  authorId: string;
  authorUsername: string;
  currentUserId: string | null;
  context?: AuthorActionContext;
}): Actions {
  capturedActions = null;
  act(() => {
    create(React.createElement(Probe, props));
  });
  if (!capturedActions) throw new Error('useAuthorActions did not return actions');
  return capturedActions;
}

// ---------------------------------------------------------------------------
// Alert helpers
// ---------------------------------------------------------------------------

interface AlertButton {
  text: string;
  style?: string;
  onPress?: () => void;
}

function getAlertButton(
  alertSpy: jest.SpyInstance,
  callIndex: number,
  buttonText: string,
): AlertButton {
  const alertArgs = alertSpy.mock.calls[callIndex];
  if (!alertArgs) throw new Error(`No Alert.alert call at index ${callIndex}`);
  const buttons = alertArgs[2] as AlertButton[];
  const btn = buttons.find((b) => b.text === buttonText);
  if (!btn) throw new Error(`No button "${buttonText}" in Alert call #${callIndex}`);
  return btn;
}

const authorId = 'u-author';
const authorUsername = 'authoruser';
const currentUserId = 'u-me';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useAuthorActions — self guard', () => {
  it('handleAuthorPress is a no-op when authorId equals currentUserId', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const actions = renderActions({
      authorId: currentUserId,
      authorUsername,
      currentUserId,
    });

    act(() => {
      actions.handleAuthorPress();
    });

    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('useAuthorActions — top-level action alert', () => {
  it('opens the action alert with Block / Report / Cancel buttons', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const actions = renderActions({ authorId, authorUsername, currentUserId });

    act(() => {
      actions.handleAuthorPress();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(title).toBe(authorUsername);
    expect(message).toBe('');
    expect((buttons as AlertButton[]).map((b) => b.text)).toEqual([
      'Block',
      'Report',
      'Cancel',
    ]);
  });
});

describe('useAuthorActions — block confirm chain', () => {
  it('Block -> confirm Block calls blockUser(authorId, authorUsername) and shows the "Also report?" follow-up', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const actions = renderActions({ authorId, authorUsername, currentUserId });

    act(() => {
      actions.handleAuthorPress();
    });
    // Tap "Block" on the top-level alert -> opens the confirm alert.
    act(() => {
      getAlertButton(alertSpy, 0, 'Block').onPress?.();
    });

    expect(alertSpy).toHaveBeenCalledTimes(2);
    const [confirmTitle, confirmMessage] = alertSpy.mock.calls[1];
    expect(confirmTitle).toBe(`Block @${authorUsername}?`);
    expect(confirmMessage).toBe('You will no longer see their posts or replies.');

    // Tap "Block" on the confirm alert -> calls blockUser and opens follow-up.
    act(() => {
      getAlertButton(alertSpy, 1, 'Block').onPress?.();
    });

    expect(mockBlockUser).toHaveBeenCalledTimes(1);
    expect(mockBlockUser).toHaveBeenCalledWith(authorId, authorUsername);

    expect(alertSpy).toHaveBeenCalledTimes(3);
    const [followUpTitle, followUpMessage, followUpButtons] = alertSpy.mock.calls[2];
    expect(followUpTitle).toBe(`Blocked @${authorUsername}`);
    expect(followUpMessage).toBe('Also report them to Orbital?');
    expect((followUpButtons as AlertButton[]).map((b) => b.text)).toEqual(['Done', 'Report']);
    expect(mockOpenReportSheet).not.toHaveBeenCalled();
  });

  it('follow-up Report calls openReportSheet with the content context payload', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const context: AuthorActionContext = {
      contentType: 'thread',
      contentId: 't-1',
      groupId: 'g-1',
    };
    const actions = renderActions({ authorId, authorUsername, currentUserId, context });

    act(() => {
      actions.handleAuthorPress();
    });
    act(() => {
      getAlertButton(alertSpy, 0, 'Block').onPress?.();
    });
    act(() => {
      getAlertButton(alertSpy, 1, 'Block').onPress?.();
    });
    // Tap "Report" on the "Also report?" follow-up.
    act(() => {
      getAlertButton(alertSpy, 2, 'Report').onPress?.();
    });

    expect(mockOpenReportSheet).toHaveBeenCalledTimes(1);
    expect(mockOpenReportSheet).toHaveBeenCalledWith({
      contentType: 'thread',
      contentId: 't-1',
      groupId: 'g-1',
      reportedUserId: authorId,
      reportedUsername: authorUsername,
    });
  });
});

describe('useAuthorActions — handleReport', () => {
  it('handleReport with context passes { contentType, contentId, groupId, reportedUserId, reportedUsername }', () => {
    const context: AuthorActionContext = {
      contentType: 'reply',
      contentId: 'r-42',
      groupId: 'g-9',
    };
    const actions = renderActions({ authorId, authorUsername, currentUserId, context });

    act(() => {
      actions.handleReport();
    });

    expect(mockOpenReportSheet).toHaveBeenCalledTimes(1);
    expect(mockOpenReportSheet).toHaveBeenCalledWith({
      contentType: 'reply',
      contentId: 'r-42',
      groupId: 'g-9',
      reportedUserId: authorId,
      reportedUsername: authorUsername,
    });
  });

  it('handleReport without context falls back to contentType "user" and undefined contentId', () => {
    const actions = renderActions({ authorId, authorUsername, currentUserId });

    act(() => {
      actions.handleReport();
    });

    expect(mockOpenReportSheet).toHaveBeenCalledTimes(1);
    expect(mockOpenReportSheet).toHaveBeenCalledWith({
      contentType: 'user',
      contentId: undefined,
      groupId: undefined,
      reportedUserId: authorId,
      reportedUsername: authorUsername,
    });
  });
});

describe('useAuthorActions — cancel path', () => {
  it('Cancel button dismisses without calling blockUser or openReportSheet', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const actions = renderActions({ authorId, authorUsername, currentUserId });

    act(() => {
      actions.handleAuthorPress();
    });
    act(() => {
      getAlertButton(alertSpy, 0, 'Block').onPress?.();
    });

    // The confirm alert's "Cancel" button has no onPress handler — dismissing
    // it must be a true no-op with no follow-up alert and no store calls.
    const cancelButton = getAlertButton(alertSpy, 1, 'Cancel');
    expect(cancelButton.onPress).toBeUndefined();

    act(() => {
      cancelButton.onPress?.();
    });

    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(mockBlockUser).not.toHaveBeenCalled();
    expect(mockOpenReportSheet).not.toHaveBeenCalled();
  });
});
