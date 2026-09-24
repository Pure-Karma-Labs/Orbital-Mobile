/**
 * Tests for ReplyItem — useAuthorActions author-context wiring (#490).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ReplyItem } from '../ReplyItem';

// Captures the onEnd callback so tests can fire the tap gesture manually.
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
  useDisplayName: (_authorId: string | null | undefined, fallback: string) => fallback,
}));

jest.mock('../../../hooks/useContactAvatar', () => ({
  useContactAvatar: () => ({
    userId: null, groupId: null,
    encryptedAvatarKey: null, avatarKeyIv: null, avatarDigest: null,
  }),
}));

jest.mock('../../../stores', () => ({
  useMediaForReply: () => [],
}));

// MediaGallery/MediaLightbox pull in useMediaDownload -> useAppStore -> MMKV,
// which needs the native NitroModules module unavailable under plain Jest.
// mediaItems is always [] here so these never render; stub them at the
// module boundary so the import chain itself doesn't execute.
jest.mock('../../../components/MediaGallery', () => ({
  MediaGallery: () => null,
}));
jest.mock('../../../components/MediaLightbox', () => ({
  MediaLightbox: () => null,
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

function renderReplyItem(
  props: Partial<React.ComponentProps<typeof ReplyItem>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ReplyItem, {
          replyId: 'r-1',
          body: 'hello',
          authorUsername: 'bob',
          authorId: 'u-bob',
          groupId: 'g-1',
          currentUserId: 'u-me',
          depth: 0,
          createdAt: Date.now(),
          syncStatus: 'synced',
          parentAuthorId: null,
          parentAuthorUsername: null,
          onPress: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Tap gesture behaviour (#749)
// ---------------------------------------------------------------------------

describe('ReplyItem — tap gesture syncStatus guard', () => {
  beforeEach(() => {
    capturedTapEndCallback = undefined;
  });

  it('does NOT call onPress when syncStatus is "pending"', () => {
    const mockOnPress = jest.fn();
    renderReplyItem({ syncStatus: 'pending', onPress: mockOnPress });
    expect(capturedTapEndCallback).toBeDefined();
    capturedTapEndCallback!();
    expect(mockOnPress).not.toHaveBeenCalled();
  });

  it('DOES call onPress when syncStatus is "synced"', () => {
    const mockOnPress = jest.fn();
    renderReplyItem({ syncStatus: 'synced', replyId: 'r-1', authorUsername: 'bob', depth: 0, onPress: mockOnPress });
    expect(capturedTapEndCallback).toBeDefined();
    capturedTapEndCallback!();
    // useDisplayName mock: (_authorId, fallback) => fallback, so displayName = 'bob'
    expect(mockOnPress).toHaveBeenCalledWith('r-1', 'bob', 0);
  });

  it('renders no "Failed to send" text for syncStatus "failed"', () => {
    const renderer = renderReplyItem({ syncStatus: 'failed' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const failedLabel = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('failed to send'),
    );
    expect(failedLabel).toBeUndefined();
  });
});

describe('ReplyItem — useAuthorActions context', () => {
  it('passes { contentType: "reply", contentId: replyId, groupId } as the 4th argument', () => {
    mockUseAuthorActions.mockClear();
    renderReplyItem({ replyId: 'r-1', groupId: 'g-1' });

    expect(mockUseAuthorActions).toHaveBeenCalled();
    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'reply',
      contentId: 'r-1',
      groupId: 'g-1',
    });
  });

  it('passes groupId: undefined when groupId prop is null', () => {
    mockUseAuthorActions.mockClear();
    renderReplyItem({ replyId: 'r-2', groupId: null });

    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'reply',
      contentId: 'r-2',
      groupId: undefined,
    });
  });
});
