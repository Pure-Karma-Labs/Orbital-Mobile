/**
 * Tests for ChatMessageItem — unread indicator (#329).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ChatMessageItem } from '../ChatMessageItem';

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

const mockUseAuthorActions = jest.fn(
  (..._args: unknown[]) => ({
    handleAuthorPress: jest.fn(),
    handleReport: jest.fn(),
  }),
);
jest.mock('../../../hooks/useAuthorActions', () => ({
  useAuthorActions: (...args: unknown[]) => mockUseAuthorActions(...args),
}));

jest.mock('../../../stores', () => ({
  useAuth: () => ({ userId: 'user-1', username: 'testuser' }),
}));

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
    const dot = renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1');
    expect(dot.length).toBeGreaterThan(0);
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === 'Unread message from bob',
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('hides the dot when read', () => {
    const renderer = renderItem({ unread: false });
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1'),
    ).toHaveLength(0);
  });

  it('shows the dot on own-authored thread rows too (other party replied)', () => {
    // In DMs a row is a thread; replies from the other person make it
    // unread regardless of who created the thread (#333 follow-up).
    const renderer = renderItem({ isOwn: true, unread: true });
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1').length,
    ).toBeGreaterThan(0);
  });

  it('hides the dot by default (prop omitted)', () => {
    const renderer = renderItem();
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1'),
    ).toHaveLength(0);
  });
});
