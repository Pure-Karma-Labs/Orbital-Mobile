/**
 * Tests for ThreadHeader — useAuthorActions author-context wiring (#490) and
 * the shared absolute timestamp (#821).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ThreadHeader } from '../ThreadHeader';
import {
  formatPostTimestamp,
  formatPostTimestampA11y,
} from '../../../utils/formatPostTimestamp';

/**
 * Fixed instant from LOCAL wall-clock parts, so the rendered string is the
 * same in any zone CI runs in; January keeps it clear of DST. The year comes
 * from the clock so the current-year (no-year) form is what is asserted.
 */
const POSTED_AT = new Date(new Date().getFullYear(), 0, 5, 15, 4).getTime();
const LAST_YEAR = new Date(new Date().getFullYear() - 1, 0, 5, 15, 4).getTime();

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
          createdAt: POSTED_AT,
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

describe('ThreadHeader — timestamp (#821)', () => {
  /** Every Text node's string content. */
  function texts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string')
      .map((n) => n.props.children as string);
  }

  it('renders the shared absolute format, not a relative one', () => {
    const renderer = renderHeader({ createdAt: POSTED_AT });
    expect(formatPostTimestamp(POSTED_AT)).toBe('Jan 5, 3:04 PM');
    expect(texts(renderer)).toContain(formatPostTimestamp(POSTED_AT));
    expect(texts(renderer).filter((t) => /(just now|\d+[mh] ago)/.test(t))).toHaveLength(0);
  });

  it('carries the year on an older post', () => {
    const renderer = renderHeader({ createdAt: LAST_YEAR });
    const rendered = formatPostTimestamp(LAST_YEAR);
    expect(rendered).toContain(String(new Date(LAST_YEAR).getFullYear()));
    expect(texts(renderer)).toContain(rendered);
  });

  it('folds the long-form timestamp into the author control label', () => {
    // The stamp sits inside the author touchable, so a screen reader only
    // reaches it through the label.
    const renderer = renderHeader({ authorId: 'u-alice', currentUserId: 'u-me' });
    const labelled = renderer.root.findAll(
      (n) =>
        n.props.accessibilityLabel ===
        `Actions for alice, posted ${formatPostTimestampA11y(POSTED_AT)}`,
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('drops the label entirely on your own post, where the control is inert', () => {
    const own = renderHeader({ authorId: 'u-me', currentUserId: 'u-me' });
    expect(
      own.root.findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Actions for'),
      ),
    ).toHaveLength(0);
  });
});
