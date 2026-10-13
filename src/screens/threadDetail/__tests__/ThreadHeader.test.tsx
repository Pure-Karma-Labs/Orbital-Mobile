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
import { findAllByTestId, findHostByTestId } from '../../../testUtils/rtr';

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

beforeEach(() => {
  handleAuthorPress.mockClear();
  handleReport.mockClear();
});

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

  it('labels the handle with the name only, and the timestamp separately in long form', () => {
    // The handle label is now just the name — the timestamp is its own sibling
    // element with a separate a11y label (#888).
    const renderer = renderHeader({ authorId: 'u-alice', currentUserId: 'u-me' });
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === 'Actions for alice',
    );
    expect(labelled.length).toBeGreaterThan(0);

    // The timestamp Text sibling carries the long-form label so a screen reader
    // reaches it as a standalone element: "3:04 PM" out of context is
    // ambiguous, "January 5 at 3:04 PM" is not (#821).
    const stampText = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        n.props.accessibilityLabel === formatPostTimestampA11y(POSTED_AT),
    );
    expect(stampText.length).toBeGreaterThan(0);

    // The avatar wrapper is a11y-hidden so VoiceOver/TalkBack doesn't stop on
    // the circle between the preceding control and the name handle.
    const avatarWrapper = renderer.root.findAll(
      (n) =>
        n.props.accessibilityElementsHidden === true &&
        n.props.importantForAccessibility === 'no-hide-descendants',
    );
    expect(avatarWrapper.length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Author handle (#888)
// ---------------------------------------------------------------------------

describe('ThreadHeader — author handle (#888)', () => {
  it('pressing the handle calls handleAuthorPress exactly once', () => {
    const renderer = renderHeader();
    const pressable = findAllByTestId(renderer.root, 'thread-header-author-handle')
      .find((n) => typeof n.props.onPress === 'function');
    expect(pressable).toBeDefined();
    act(() => {
      pressable!.props.onPress();
    });
    expect(handleAuthorPress).toHaveBeenCalledTimes(1);
  });

  it('handle frame: minWidth 44, alignSelf stretch, no hitSlop', () => {
    const renderer = renderHeader();
    const hostNode = findHostByTestId(renderer.root, 'thread-header-author-handle');
    expect(hostNode.props.style).toEqual(
      expect.objectContaining({ minWidth: 44, alignSelf: 'stretch' }),
    );
    expect(hostNode.props.hitSlop).toBeUndefined();
  });

  it('isSelf: handle is disabled, accessibilityRole and accessibilityLabel are absent', () => {
    const renderer = renderHeader({ authorId: 'u-me', currentUserId: 'u-me' });
    const pressable = findAllByTestId(renderer.root, 'thread-header-author-handle')
      .find((n) => typeof n.props.onPress === 'function');
    expect(pressable).toBeDefined();
    expect(pressable!.props.disabled).toBe(true);
    expect(pressable!.props.accessibilityRole).toBeUndefined();
    expect(pressable!.props.accessibilityLabel).toBeUndefined();
  });

  it('structural: the avatar wrapper and timestamp Text are not descendants of any onPress node', () => {
    const renderer = renderHeader();

    // (a) Positive control: there are onPress nodes in the tree.
    const pressNodes = renderer.root.findAll((n) => typeof n.props.onPress === 'function');
    expect(pressNodes.length).toBeGreaterThan(0);

    // (b) Positive control: the avatar wrapper and the timestamp Text are
    //     actually rendered — the check cannot pass vacuously.
    const avatarWrappers = renderer.root.findAll(
      (n) =>
        n.props.accessibilityElementsHidden === true &&
        n.props.importantForAccessibility === 'no-hide-descendants',
    );
    expect(avatarWrappers.length).toBeGreaterThan(0);
    const timestampTexts = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        n.props.accessibilityLabel === formatPostTimestampA11y(POSTED_AT),
    );
    expect(timestampTexts.length).toBeGreaterThan(0);

    // (c) No onPress node contains the avatar wrapper or timestamp as a descendant.
    for (const pressNode of pressNodes) {
      expect(
        pressNode.findAll(
          (n) =>
            n.props.accessibilityElementsHidden === true &&
            n.props.importantForAccessibility === 'no-hide-descendants',
        ),
      ).toHaveLength(0);
      expect(
        pressNode.findAll(
          (n) =>
            typeof n.type === 'string' &&
            n.props.accessibilityLabel === formatPostTimestampA11y(POSTED_AT),
        ),
      ).toHaveLength(0);
    }
  });
});
