/**
 * Tests for ReplyItem — useAuthorActions author-context wiring (#490), the
 * #749 unsynced-row guard, the #518 explicit reply arrow, and the #821
 * parentState context line.
 */

import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider, lightColors } from '../../../theme';
import { ReplyItem } from '../ReplyItem';

// Stub the emoji asset layer: the arrow's identity is asserted via the
// `unified` code rather than a decoded WebP. `tintColor` is passed through so
// the contrast fix stays observable.
jest.mock('../../../components/Emoji', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    Emoji: (props: { unified: string; size?: number; tintColor?: string }) =>
      ReactModule.createElement(View, {
        testID: `mock-emoji-${props.unified}`,
        tintColor: props.tintColor,
      }),
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
          parentState: 'none' as const,
          parentAuthorId: null,
          parentAuthorUsername: null,
          onReplyPress: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

/** All nodes carrying a testID (host + composite duplicates included). */
function nodesWithTestId(renderer: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll((n) => n.props.testID === testID, { deep: true });
}

/**
 * The pressable node for a testID. TouchableOpacity propagates its props down
 * several composite layers before the host view, so match on the outermost
 * one that still carries `onPress` — that's the node a test can invoke.
 *
 * Uniqueness is asserted on the HOST node instead (exactly one rendered
 * element), since the composite layers are an implementation detail of
 * TouchableOpacity.
 */
function pressableFor(renderer: ReactTestRenderer, testID: string): ReactTestInstance {
  const tagged = nodesWithTestId(renderer, testID);
  expect(tagged.filter((n) => typeof n.type === 'string')).toHaveLength(1);
  const pressables = tagged.filter((n) => typeof n.props.onPress === 'function');
  expect(pressables.length).toBeGreaterThan(0);
  return pressables[0];
}

const REPLY_BUTTON = 'reply-item-r-1-reply-button';

// ---------------------------------------------------------------------------
// Reply arrow — #749 unsynced guard
// ---------------------------------------------------------------------------

describe('ReplyItem — reply arrow syncStatus guard (#749)', () => {
  it.each(['pending', 'syncing', 'failed'] as const)(
    'renders the arrow disabled and does NOT call onReplyPress when syncStatus is "%s"',
    (syncStatus) => {
      const onReplyPress = jest.fn();
      const renderer = renderReplyItem({ syncStatus, onReplyPress });
      const btn = pressableFor(renderer, REPLY_BUTTON);

      expect(btn.props.disabled).toBe(true);
      expect(btn.props.accessibilityState).toEqual({ disabled: true });

      // Invoking onPress directly bypasses `disabled` exactly the way a
      // stale/mid-flight native press would: the in-handler guard is what
      // has to hold.
      act(() => {
        btn.props.onPress();
      });
      expect(onReplyPress).not.toHaveBeenCalled();
    },
  );

  it('calls onReplyPress with (replyId, displayName, depth) when synced', () => {
    const onReplyPress = jest.fn();
    const renderer = renderReplyItem({ syncStatus: 'synced', onReplyPress });
    const btn = pressableFor(renderer, REPLY_BUTTON);

    expect(btn.props.disabled).toBe(false);
    expect(btn.props.accessibilityState).toEqual({ disabled: false });
    expect(btn.props.accessibilityLabel).toBe('Reply to bob');

    act(() => {
      btn.props.onPress();
    });
    // useDisplayName mock: (_authorId, fallback) => fallback, so displayName = 'bob'
    expect(onReplyPress).toHaveBeenCalledWith('r-1', 'bob', 0);
  });

  it('keeps the arrow rendered (not hidden) on unsynced rows so sync causes no layout shift', () => {
    expect(nodesWithTestId(renderReplyItem({ syncStatus: 'pending' }), REPLY_BUTTON).length)
      .toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Reply arrow on your own replies
// ---------------------------------------------------------------------------

describe('ReplyItem — reply arrow on own rows (isSelf)', () => {
  it('stays enabled and fires when the author is the current user', () => {
    const onReplyPress = jest.fn();
    const renderer = renderReplyItem({
      authorId: 'u-me',
      currentUserId: 'u-me',
      syncStatus: 'synced',
      onReplyPress,
    });
    const btn = pressableFor(renderer, REPLY_BUTTON);

    expect(btn.props.disabled).toBe(false);
    act(() => {
      btn.props.onPress();
    });
    expect(onReplyPress).toHaveBeenCalledWith('r-1', 'bob', 0);
  });

  it('does not nest the reply button inside the author touchable (which is disabled on own rows)', () => {
    const renderer = renderReplyItem({ authorId: 'u-me', currentUserId: 'u-me' });
    const authorTouchable = renderer.root.findAll(
      (n) => typeof n.props.onPress === 'function' && n.props.disabled === true && n.props.testID == null,
    );
    expect(authorTouchable.length).toBeGreaterThan(0);
    for (const node of authorTouchable) {
      expect(node.findAll((c) => c.props.testID === REPLY_BUTTON)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural guard — the container tap is gone (#518)
// ---------------------------------------------------------------------------

describe('ReplyItem — structural #518 guard', () => {
  it('leaves the row container passive: no accessibilityRole, onPress or responder handler', () => {
    const renderer = renderReplyItem();
    const containers = nodesWithTestId(renderer, 'reply-item-r-1');
    expect(containers.length).toBeGreaterThan(0);
    for (const node of containers) {
      expect(node.props.accessibilityRole).toBeUndefined();
      expect(node.props.accessibilityLabel).toBeUndefined();
      expect(node.props.onPress).toBeUndefined();
      expect(node.props.onStartShouldSetResponder).toBeUndefined();
    }
  });

  it('renders exactly one reply control, carrying the OpenMoji hooked arrow', () => {
    const renderer = renderReplyItem();
    pressableFor(renderer, REPLY_BUTTON); // asserts exactly one host control
    expect(nodesWithTestId(renderer, 'mock-emoji-21A9-FE0F').length).toBeGreaterThan(0);
  });

  it('tints the arrow with textSecondary — the raster is all-black and would vanish on dark rows', () => {
    const renderer = renderReplyItem();
    const glyphs = nodesWithTestId(renderer, 'mock-emoji-21A9-FE0F');
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.props.tintColor).toBe(lightColors.textSecondary);
    }
  });

  it('keeps the body selectable', () => {
    const renderer = renderReplyItem({ body: 'hello' });
    const selectable = renderer.root.findAll((n) => n.props.selectable === true);
    expect(selectable.length).toBeGreaterThan(0);
    const bodyNode = selectable.find((n) => n.props.children === 'hello');
    expect(bodyNode).toBeDefined();
  });

  it('clamps the author name to one line so the arrow keeps its frame', () => {
    const renderer = renderReplyItem();
    const nameNode = renderer.root.findAll(
      (n) => n.props.numberOfLines === 1 && n.props.children === 'bob',
    );
    expect(nameNode.length).toBeGreaterThan(0);
  });

  it('folds the timestamp into the author control label on other people\'s replies', () => {
    // The timestamp Text lives inside the author touchable, so it is invisible
    // to a screen reader unless the label carries it.
    const renderer = renderReplyItem({
      authorId: 'u-bob',
      currentUserId: 'u-me',
      createdAt: Date.now() - 2 * 3600000,
    });
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === 'Actions for bob, posted 2h ago',
    );
    expect(labelled.length).toBeGreaterThan(0);

    // ...and drops the label entirely on your own rows, where the control is inert.
    const own = renderReplyItem({ authorId: 'u-me', currentUserId: 'u-me' });
    expect(
      own.root.findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Actions for'),
      ),
    ).toHaveLength(0);
  });

  it('keeps the author and arrow hit regions from overlapping', () => {
    const renderer = renderReplyItem();

    // Arrow: no LEFT slop, so it cannot cover the timestamp.
    expect(pressableFor(renderer, REPLY_BUTTON).props.hitSlop).toEqual({
      top: 8, bottom: 8, right: 8, left: 0,
    });

    // Author: no RIGHT slop, so it cannot reach into the arrow's frame.
    const authorControl = renderer.root
      .findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Actions for'),
      )
      .find((n) => typeof n.props.onPress === 'function');
    expect(authorControl).toBeDefined();
    expect(authorControl!.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 0 });
  });
});

// ---------------------------------------------------------------------------
// Parent context line (#821)
// ---------------------------------------------------------------------------

describe('ReplyItem — parentState context line (#821)', () => {
  const CONTEXT = 'reply-item-r-1-parent-context';

  function contextText(renderer: ReactTestRenderer): string | undefined {
    const nodes = nodesWithTestId(renderer, CONTEXT);
    return nodes.length > 0 ? (nodes[0].props.children as string) : undefined;
  }

  it('renders no context line for a top-level reply', () => {
    const renderer = renderReplyItem({ parentState: 'none' });
    expect(nodesWithTestId(renderer, CONTEXT)).toHaveLength(0);
  });

  it('names the parent author when the parent is loaded and visible', () => {
    const renderer = renderReplyItem({
      parentState: 'jumpable',
      parentAuthorId: 'u-ann',
      parentAuthorUsername: 'ann',
    });
    expect(contextText(renderer)).toBe('↳ Replying to @ann');
  });

  it('says "an earlier reply" for an orphan (parent not loaded)', () => {
    const renderer = renderReplyItem({
      parentState: 'orphan',
      parentAuthorId: null,
      parentAuthorUsername: null,
    });
    expect(contextText(renderer)).toBe('↳ Replying to an earlier reply');
  });

  it('says "a hidden reply" and never names a blocked parent author', () => {
    // The screen nulls the parent fields for a hidden parent; even if a stale
    // name were passed, the hidden branch must not render it.
    const renderer = renderReplyItem({
      parentState: 'hidden',
      parentAuthorId: 'u-blocked',
      parentAuthorUsername: 'blockedname',
    });
    expect(contextText(renderer)).toBe('↳ Replying to a hidden reply');

    const leaked = renderer.root.findAll(
      (n) =>
        typeof n.props.children === 'string' &&
        n.props.children.includes('blockedname'),
    );
    expect(leaked).toHaveLength(0);
  });

  it('renders the context line above the author row, outside any touchable', () => {
    const renderer = renderReplyItem({
      parentState: 'jumpable',
      parentAuthorId: 'u-ann',
      parentAuthorUsername: 'ann',
    });
    const pressables = renderer.root.findAll(
      (n) => typeof n.props.onPress === 'function',
    );
    // PR1 is text only — the jump control arrives in PR2.
    for (const node of pressables) {
      expect(node.findAll((c) => c.props.testID === CONTEXT)).toHaveLength(0);
    }
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
