/**
 * Tests for ThreadHeader — useAuthorActions author-context wiring (#490).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ThreadHeader } from '../ThreadHeader';

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: { Tap: () => ({ onEnd: () => ({ runOnJS: () => ({}) }) }) },
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

jest.mock('../../../stores', () => ({
  useMediaForThread: () => [],
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

function renderHeader(
  props: Partial<React.ComponentProps<typeof ThreadHeader>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ThreadHeader, {
          threadId: 't-1',
          title: 'Thread title',
          body: 'hello',
          authorUsername: 'alice',
          authorId: 'u-alice',
          groupId: 'g-1',
          currentUserId: 'u-me',
          createdAt: Date.now(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

describe('ThreadHeader — useAuthorActions context', () => {
  it('passes { contentType: "thread", contentId: threadId, groupId } as the 4th argument', () => {
    mockUseAuthorActions.mockClear();
    renderHeader({ threadId: 't-1', groupId: 'g-1' });

    expect(mockUseAuthorActions).toHaveBeenCalled();
    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'thread',
      contentId: 't-1',
      groupId: 'g-1',
    });
  });

  it('re-derives the context when threadId or groupId changes', () => {
    mockUseAuthorActions.mockClear();
    renderHeader({ threadId: 't-2', groupId: 'g-2' });

    const lastCall = mockUseAuthorActions.mock.calls[mockUseAuthorActions.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({
      contentType: 'thread',
      contentId: 't-2',
      groupId: 'g-2',
    });
  });
});
