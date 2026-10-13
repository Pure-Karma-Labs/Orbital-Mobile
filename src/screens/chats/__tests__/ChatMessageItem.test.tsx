/**
 * Tests for ChatMessageItem — unread indicator (#329).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ChatMessageItem } from '../ChatMessageItem';
import { findAllByTestId, findHostByTestId } from '../../../testUtils/rtr';

// Captures the onEnd callback so tests can fire the row tap manually.
// The chainable shape mirrors the real API: Tap() → onEnd(cb) → runOnJS() → same handler.
let capturedTapEndCallback: (() => void) | undefined;
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: {
      Tap: () => {
        const handler: {
          onEnd: (cb: () => void) => typeof handler;
          runOnJS: () => typeof handler;
        } = {
          onEnd(cb: () => void) {
            capturedTapEndCallback = cb;
            return handler;
          },
          runOnJS() {
            return handler;
          },
        };
        return handler;
      },
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});

jest.mock('../../../hooks/useDisplayName', () => ({
  useDisplayName: (_authorId: string, fallback: string) => fallback,
}));

jest.mock('../../../hooks/useContactAvatar', () => ({
  useContactAvatar: () => ({
    userId: null, groupId: null,
    encryptedAvatarKey: null, avatarKeyIv: null, avatarDigest: null,
  }),
}));

// Hoisted, stable spies returned by every mock call so handle-press assertions
// are unambiguous regardless of how many renders share a describe block.
const handleAuthorPress = jest.fn();
const handleReport = jest.fn();

const mockUseAuthorActions = jest.fn(
  (..._args: unknown[]) => ({
    handleAuthorPress,
    handleReport,
  }),
);
jest.mock('../../../hooks/useAuthorActions', () => ({
  useAuthorActions: (...args: unknown[]) => mockUseAuthorActions(...args),
}));

jest.mock('../../../stores', () => ({
  useAuth: () => ({ userId: 'user-1', username: 'testuser' }),
}));

beforeEach(() => {
  handleAuthorPress.mockClear();
  handleReport.mockClear();
});

function renderItem(
  props: Partial<React.ComponentProps<typeof ChatMessageItem>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ChatMessageItem, {
          threadId: 't-1',
          authorId: 'u-bob',
          body: 'hello',
          author: 'bob',
          groupId: 'g-1',
          time: '11:00 AM',
          isOwn: false,
          onPress: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

describe('ChatMessageItem — useAuthorActions context', () => {
  it('passes message context with threadId and groupId as 4th argument', () => {
    mockUseAuthorActions.mockClear();
    renderItem({ threadId: 't-1', groupId: 'g-1' });

    expect(mockUseAuthorActions).toHaveBeenCalled();
    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'message',
      contentId: 't-1',
      groupId: 'g-1',
    });
  });

  it('passes undefined groupId when groupId prop is null', () => {
    mockUseAuthorActions.mockClear();
    renderItem({ threadId: 't-2', groupId: null });

    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'message',
      contentId: 't-2',
      groupId: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Row tap + preview selection (#518)
// ---------------------------------------------------------------------------

describe('ChatMessageItem — navigation row model (#518)', () => {
  beforeEach(() => {
    capturedTapEndCallback = undefined;
  });

  it('renders the 4-line preview but does NOT make it selectable', () => {
    const renderer = renderItem({ body: 'hello' });
    const preview = renderer.root.findAll((n) => n.props.numberOfLines === 4);
    expect(preview.length).toBeGreaterThan(0);
    for (const node of preview) {
      expect(node.props.selectable).toBeFalsy();
    }
    // Nothing else in the row is selectable either.
    expect(renderer.root.findAll((n) => n.props.selectable === true)).toHaveLength(0);
  });

  it('keeps the whole-row tap: it is navigation, not a reply action', () => {
    const onPress = jest.fn();
    renderItem({ threadId: 't-1', onPress });
    expect(capturedTapEndCallback).toBeDefined();
    act(() => {
      capturedTapEndCallback!();
    });
    expect(onPress).toHaveBeenCalledWith('t-1');
  });
});

describe('ChatMessageItem — unread indicator', () => {
  it('shows the unread dot and accessibility label when unread', () => {
    const renderer = renderItem({ unread: true });
    const dot = findAllByTestId(renderer.root, 'chat-unread-dot-t-1');
    expect(dot.length).toBeGreaterThan(0);
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === 'Unread message from bob',
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('hides the dot when read', () => {
    const renderer = renderItem({ unread: false });
    expect(findAllByTestId(renderer.root, 'chat-unread-dot-t-1')).toHaveLength(0);
  });

  it('shows the dot on own-authored thread rows too (other party replied)', () => {
    // In DMs a row is a thread; replies from the other person make it
    // unread regardless of who created the thread (#333 follow-up).
    const renderer = renderItem({ isOwn: true, unread: true });
    expect(findAllByTestId(renderer.root, 'chat-unread-dot-t-1').length).toBeGreaterThan(0);
  });

  it('hides the dot by default (prop omitted)', () => {
    const renderer = renderItem();
    expect(findAllByTestId(renderer.root, 'chat-unread-dot-t-1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Author handle (#888)
// ---------------------------------------------------------------------------

describe('ChatMessageItem — author handle (#888)', () => {
  it('pressing the handle calls handleAuthorPress exactly once', () => {
    const renderer = renderItem();
    const pressable = findAllByTestId(renderer.root, 'chat-message-t-1-author-handle')
      .find((n) => typeof n.props.onPress === 'function');
    expect(pressable).toBeDefined();
    act(() => {
      pressable!.props.onPress();
    });
    expect(handleAuthorPress).toHaveBeenCalledTimes(1);
  });

  it('handle frame: minWidth 44, alignSelf stretch, no hitSlop', () => {
    const renderer = renderItem();
    const hostNode = findHostByTestId(renderer.root, 'chat-message-t-1-author-handle');
    expect(hostNode.props.style).toEqual(
      expect.objectContaining({ minWidth: 44, alignSelf: 'stretch' }),
    );
    expect(hostNode.props.hitSlop).toBeUndefined();
  });

  it('isSelf: handle is disabled, accessibilityRole and accessibilityLabel are absent', () => {
    // authorId: 'user-1' matches useAuth's userId: 'user-1', so isSelf = true
    const renderer = renderItem({ authorId: 'user-1' });
    const pressable = findAllByTestId(renderer.root, 'chat-message-t-1-author-handle')
      .find((n) => typeof n.props.onPress === 'function');
    expect(pressable).toBeDefined();
    expect(pressable!.props.disabled).toBe(true);
    expect(pressable!.props.accessibilityRole).toBeUndefined();
    expect(pressable!.props.accessibilityLabel).toBeUndefined();
  });

  it('structural: the avatar, the time and the unread dot are outside every Touchable', () => {
    const renderer = renderItem({ unread: true });

    // (a) Positive control: the row HAS a Touchable (the author handle).
    //
    // Matched on the responder handler of the host view, NOT on `onPress`:
    // this component takes an `onPress` PROP (the row's navigation callback,
    // fired from the GestureDetector), so its own element node carries
    // `onPress` and contains the entire row. An `onPress` predicate here would
    // report the whole row as a target and could never go green.
    //
    // NOTE: the whole-row RNGH Gesture.Tap is invisible to this check — it is
    // not a Touchable and leaves no onStartShouldSetResponder in the tree.
    // That tap is verified end-to-end by device smoke.
    const touchSurfaces = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        typeof n.props.onStartShouldSetResponder === 'function',
    );
    expect(touchSurfaces.length).toBeGreaterThan(0);

    // (b) Positive control: the avatar, the time Text and the unread dot are
    //     actually rendered — the check cannot pass vacuously.
    const avatarInitials = renderer.root.findAll(
      (n) => typeof n.type === 'string' && n.props.allowFontScaling === false,
    );
    expect(avatarInitials.length).toBeGreaterThan(0);
    const timeTexts = renderer.root.findAll(
      (n) => typeof n.type === 'string' && n.props.children === '11:00 AM',
    );
    expect(timeTexts.length).toBeGreaterThan(0);
    const unreadDots = findAllByTestId(renderer.root, 'chat-unread-dot-t-1');
    expect(unreadDots.length).toBeGreaterThan(0);

    // (c) None of the three is inside a Touchable.
    for (const surface of touchSurfaces) {
      expect(
        surface.findAll(
          (n) => typeof n.type === 'string' && n.props.allowFontScaling === false,
        ),
      ).toHaveLength(0);
      expect(
        surface.findAll(
          (n) => typeof n.type === 'string' && n.props.children === '11:00 AM',
        ),
      ).toHaveLength(0);
      expect(findAllByTestId(surface, 'chat-unread-dot-t-1')).toHaveLength(0);
    }
  });

  it('non-own row declares exactly [activate, authorActions] accessibility actions', () => {
    // `activate` is the screen-reader equivalent of the RNGH row tap (which
    // TalkBack cannot see), and `authorActions` is the only route to
    // Block/Report on a DM row where the container merges its children on iOS.
    const renderer = renderItem();
    const withActions = renderer.root.findAll((n) => n.props.accessibilityActions != null);
    expect(withActions.length).toBeGreaterThan(0);
    for (const node of withActions) {
      expect(node.props.accessibilityActions).toEqual([
        { name: 'activate' },
        { name: 'authorActions', label: 'Actions for bob' },
      ]);
    }
  });

  it('onAccessibilityAction fires handleAuthorPress for "authorActions"', () => {
    const renderer = renderItem();
    const containers = renderer.root.findAll(
      (n) => typeof n.props.onAccessibilityAction === 'function',
    );
    expect(containers.length).toBeGreaterThan(0);
    act(() => {
      containers[0].props.onAccessibilityAction({
        nativeEvent: { actionName: 'authorActions' },
      });
    });
    expect(handleAuthorPress).toHaveBeenCalledTimes(1);
  });

  it('onAccessibilityAction "activate" calls onPress with the threadId on both own and other rows', () => {
    // Non-own row: activate is the screen-reader equivalent of the RNGH row tap.
    const onPressOther = jest.fn();
    const rendererOther = renderItem({ threadId: 't-1', authorId: 'u-bob', onPress: onPressOther });
    const containerOther = rendererOther.root.findAll(
      (n) => typeof n.props.onAccessibilityAction === 'function',
    );
    expect(containerOther.length).toBeGreaterThan(0);
    act(() => {
      containerOther[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(onPressOther).toHaveBeenCalledTimes(1);
    expect(onPressOther).toHaveBeenCalledWith('t-1');

    // Own row (authorId: 'user-1' matches useAuth's userId: 'user-1', so isSelf = true).
    // activate must still open the thread on own rows — it is the only screen-reader
    // route to navigation when authorActions is absent.
    const onPressOwn = jest.fn();
    const rendererOwn = renderItem({ threadId: 't-1', authorId: 'user-1', onPress: onPressOwn });
    const containerOwn = rendererOwn.root.findAll(
      (n) => typeof n.props.onAccessibilityAction === 'function',
    );
    expect(containerOwn.length).toBeGreaterThan(0);
    act(() => {
      containerOwn[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(onPressOwn).toHaveBeenCalledTimes(1);
    expect(onPressOwn).toHaveBeenCalledWith('t-1');
  });

  it('onAccessibilityAction routes nothing for an undeclared actionName', () => {
    // 'magicTap' is a standard iOS action this row never declares: the handler
    // must ignore it rather than fall through to either branch.
    const onPress = jest.fn();
    const renderer = renderItem({ onPress });
    const containers = renderer.root.findAll(
      (n) => typeof n.props.onAccessibilityAction === 'function',
    );
    expect(containers.length).toBeGreaterThan(0);
    act(() => {
      containers[0].props.onAccessibilityAction({
        nativeEvent: { actionName: 'magicTap' },
      });
    });
    expect(handleAuthorPress).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('own rows declare exactly [activate] and still attach onAccessibilityAction', () => {
    // authorId: 'user-1' matches useAuth's userId: 'user-1', so isSelf = true.
    // Own rows omit `authorActions` (Block/Report is irrelevant on your own posts)
    // but still declare `activate` so screen readers can navigate to the thread.
    const renderer = renderItem({ authorId: 'user-1' });
    const withActions = renderer.root.findAll(
      (n) => n.props.accessibilityActions != null,
    );
    expect(withActions.length).toBeGreaterThan(0);
    for (const node of withActions) {
      expect(node.props.accessibilityActions).toEqual([{ name: 'activate' }]);
    }
    const withActionHandler = renderer.root.findAll(
      (n) => typeof n.props.onAccessibilityAction === 'function',
    );
    expect(withActionHandler.length).toBeGreaterThan(0);
  });
});
