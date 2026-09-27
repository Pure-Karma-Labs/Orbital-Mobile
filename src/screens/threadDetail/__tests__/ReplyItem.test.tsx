/**
 * Tests for ReplyItem — useAuthorActions author-context wiring (#490), the
 * #749 unsynced-row guard, the #518 explicit reply arrow, and the #821
 * parentState context line, jump control, collapse toggle and absolute
 * two-line timestamps.
 */

import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider, lightColors } from '../../../theme';
import { ReplyItem } from '../ReplyItem';
import { formatPostTimestamp, formatPostTimestampA11y } from '../../../utils/formatPostTimestamp';

/**
 * Fixed instant, built from LOCAL wall-clock parts so the rendered string is
 * the same in every zone CI might run in. January keeps it clear of DST.
 * The year is taken from the clock so the "current year" (no-year) format is
 * what the assertions see, whatever year the suite runs in.
 */
const POSTED_AT = new Date(new Date().getFullYear(), 0, 5, 15, 4).getTime();
const POSTED_TEXT = formatPostTimestamp(POSTED_AT);
const POSTED_A11Y = formatPostTimestampA11y(POSTED_AT);

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
          createdAt: POSTED_AT,
          syncStatus: 'synced',
          parentState: 'none' as const,
          parentId: null,
          parentAuthorId: null,
          parentAuthorUsername: null,
          onReplyPress: jest.fn(),
          onParentPress: jest.fn(),
          visibleDescendants: 0,
          collapsed: false,
          onToggleCollapse: jest.fn(),
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
      createdAt: POSTED_AT,
    });
    // Long form, not the compact on-screen form: "3:04 PM" read out of
    // context is ambiguous, "January 5 at 3:04 PM" is not.
    expect(POSTED_A11Y).toBe('January 5 at 3:04 PM');
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === `Actions for bob, posted ${POSTED_A11Y}`,
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

    // Author: no RIGHT slop (the arrow's frame is to its right). With no jump
    // control above (parentState 'none' here) it keeps its usual 4pt top.
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

  it.each([
    ['none' as const, null, 4],
    ['orphan' as const, 'r-parent', 4],
    ['hidden' as const, 'r-parent', 4],
    ['jumpable' as const, 'r-parent', 0],
  ])(
    'gives the author block hitSlop.top %s -> %s',
    (parentState, parentId, expected) => {
      // 0 ONLY under a live jump control, whose 8pt bottom slop reaches down
      // to this edge; otherwise nothing is contesting it (#843 review).
      const renderer = renderReplyItem({
        parentState,
        parentId,
        parentAuthorId: 'u-ann',
        parentAuthorUsername: 'ann',
      });
      const authorControl = renderer.root
        .findAll(
          (n) =>
            typeof n.props.accessibilityLabel === 'string' &&
            n.props.accessibilityLabel.startsWith('Actions for'),
        )
        .find((n) => typeof n.props.onPress === 'function');
      expect(authorControl!.props.hitSlop).toEqual({
        top: expected,
        bottom: 4,
        left: 4,
        right: 0,
      });
    },
  );
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
    // Naming the parent requires BOTH a jumpable state and an id to jump to.
    const renderer = renderReplyItem({
      parentState: 'jumpable',
      parentId: 'r-parent',
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

  it.each(['orphan', 'hidden'] as const)(
    'leaves the %s context line untouchable — it names no destination',
    (parentState) => {
      const renderer = renderReplyItem({ parentState, parentId: 'r-parent' });
      expect(nodesWithTestId(renderer, JUMP)).toHaveLength(0);
      for (const node of renderer.root.findAll((n) => typeof n.props.onPress === 'function')) {
        expect(node.findAll((c) => c.props.testID === CONTEXT)).toHaveLength(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Jump control (#821 PR2)
// ---------------------------------------------------------------------------

const JUMP = 'reply-item-r-1-parent-jump';

describe('ReplyItem — jumpable context line', () => {
  const jumpableProps = {
    parentState: 'jumpable' as const,
    parentId: 'r-parent',
    parentAuthorId: 'u-ann',
    parentAuthorUsername: 'ann',
  };

  it('calls onParentPress with the parent id', () => {
    const onParentPress = jest.fn();
    const renderer = renderReplyItem({ ...jumpableProps, onParentPress });
    const control = pressableFor(renderer, JUMP);
    act(() => {
      control.props.onPress();
    });
    expect(onParentPress).toHaveBeenCalledWith('r-parent');
  });

  it('is a button labelled for the parent author', () => {
    const control = pressableFor(renderReplyItem(jumpableProps), JUMP);
    expect(control.props.accessibilityRole).toBe('button');
    // No '@' in the SPOKEN label; the visible line keeps it.
    expect(control.props.accessibilityLabel).toBe("Go to ann's reply");
    expect(control.props.accessibilityLabel).not.toContain('@');
  });

  it('carries vertical-only hitSlop so it cannot reach the author control', () => {
    const control = pressableFor(renderReplyItem(jumpableProps), JUMP);
    expect(control.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 0, right: 0 });
  });

  it('gives the control a 32pt frame — slop alone is not a touch target', () => {
    const control = pressableFor(renderReplyItem(jumpableProps), JUMP);
    const frames = nodesWithTestId(renderReplyItem(jumpableProps), JUMP)
      .filter((n) => typeof n.type === 'string');
    expect(control.props.hitSlop).toBeDefined();
    // The bottom margin is LOAD-BEARING: the author block starts right below
    // and wins as the later sibling, so without an 8pt gap the 8pt bottom
    // slop band would be dead and land on Block/Report (#843 review).
    expect(frames[0].props.style).toEqual(
      expect.objectContaining({ minHeight: 32, marginBottom: 8 }),
    );
  });

  it('falls back to the unnamed, untouchable line when the parent id is missing', () => {
    // `jumpable` with no id has no destination, so it must not offer one —
    // and must not name the parent either (the only non-jumpable path that
    // still named one was removed in the #843 review).
    const onParentPress = jest.fn();
    const renderer = renderReplyItem({
      ...jumpableProps,
      parentId: null,
      onParentPress,
    });
    expect(nodesWithTestId(renderer, JUMP)).toHaveLength(0);
    expect(onParentPress).not.toHaveBeenCalled();

    const line = nodesWithTestId(renderer, 'reply-item-r-1-parent-context');
    expect(line[0].props.children).toBe('↳ Replying to an earlier reply');
    expect(
      renderer.root.findAll(
        (n) => typeof n.props.children === 'string' && n.props.children.includes('ann'),
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Collapse toggle (#821 PR2)
// ---------------------------------------------------------------------------

const TOGGLE = 'reply-item-r-1-collapse-toggle';

describe('ReplyItem — collapse toggle', () => {
  function toggleText(renderer: ReactTestRenderer): string | undefined {
    const host = nodesWithTestId(renderer, TOGGLE).filter((n) => typeof n.type === 'string');
    if (host.length === 0) return undefined;
    const texts = host[0].findAll(
      (n) => typeof n.type === 'string' && typeof n.props.children === 'string',
    );
    return texts.length > 0 ? (texts[0].props.children as string) : undefined;
  }

  it('renders no toggle on a row with no visible descendants', () => {
    expect(nodesWithTestId(renderReplyItem({ visibleDescendants: 0 }), TOGGLE)).toHaveLength(0);
  });

  it('reads "[-] hide N replies" while expanded', () => {
    const renderer = renderReplyItem({ visibleDescendants: 3, collapsed: false });
    expect(toggleText(renderer)).toBe('[\u2013] hide 3 replies');
  });

  it('reads "[+] N replies" while collapsed', () => {
    const renderer = renderReplyItem({ visibleDescendants: 3, collapsed: true });
    expect(toggleText(renderer)).toBe('[+] 3 replies');
  });

  it('singularizes a lone reply', () => {
    expect(toggleText(renderReplyItem({ visibleDescendants: 1 }))).toBe('[\u2013] hide 1 reply');
  });

  it('announces expanded state and names the author', () => {
    const expanded = pressableFor(renderReplyItem({ visibleDescendants: 2 }), TOGGLE);
    expect(expanded.props.accessibilityRole).toBe('button');
    expect(expanded.props.accessibilityState).toEqual({ expanded: true });
    expect(expanded.props.accessibilityLabel).toBe('Hide 2 replies to bob');

    const collapsed = pressableFor(
      renderReplyItem({ visibleDescendants: 2, collapsed: true }),
      TOGGLE,
    );
    expect(collapsed.props.accessibilityState).toEqual({ expanded: false });
    expect(collapsed.props.accessibilityLabel).toBe('Show 2 replies to bob');
  });

  it('calls onToggleCollapse with this row id', () => {
    const onToggleCollapse = jest.fn();
    const renderer = renderReplyItem({ visibleDescendants: 2, onToggleCollapse });
    act(() => {
      pressableFor(renderer, TOGGLE).props.onPress();
    });
    expect(onToggleCollapse).toHaveBeenCalledWith('r-1');
  });

  it('gives the toggle a 44 x 32pt frame plus vertical slop', () => {
    const renderer = renderReplyItem({ visibleDescendants: 2 });
    const control = pressableFor(renderer, TOGGLE);
    expect(control.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 0, right: 0 });
    const host = nodesWithTestId(renderer, TOGGLE).filter((n) => typeof n.type === 'string');
    // The top margin keeps the upper slop band off the media gallery / link
    // preview card above, which are pressable themselves (#843 review).
    expect(host[0].props.style).toEqual(
      expect.objectContaining({ minWidth: 44, minHeight: 32, marginTop: 8 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Absolute timestamps and the two-line threshold (#821 PR2)
// ---------------------------------------------------------------------------

describe('ReplyItem — timestamps', () => {
  /** The timestamp Text node (it is the only one rendering POSTED_TEXT). */
  function stampNode(renderer: ReactTestRenderer): ReactTestInstance {
    const nodes = renderer.root.findAll(
      (n) => typeof n.type === 'string' && n.props.children === POSTED_TEXT,
    );
    expect(nodes).toHaveLength(1);
    return nodes[0];
  }

  it('renders an absolute date and time, never a relative one', () => {
    const renderer = renderReplyItem({ createdAt: POSTED_AT });
    expect(POSTED_TEXT).toBe('Jan 5, 3:04 PM');
    expect(stampNode(renderer)).toBeDefined();
    const relative = renderer.root.findAll(
      (n) =>
        typeof n.props.children === 'string' &&
        /(just now|\d+[mh] ago)/.test(n.props.children),
    );
    expect(relative).toHaveLength(0);
  });

  it.each([0, 1])('keeps the timestamp inline at depth %i', (depth) => {
    // Inline: it sits beside the name and needs the gutter.
    expect(stampNode(renderReplyItem({ depth })).props.style).toEqual(
      expect.objectContaining({ marginLeft: 8 }),
    );
  });

  it.each([2, 3, 4])('moves the timestamp to its own line at depth %i', (depth) => {
    // Stacked under the name inside the name column, so no gutter.
    expect(stampNode(renderReplyItem({ depth })).props.style).toEqual(
      expect.objectContaining({ marginLeft: 0 }),
    );
  });

  it('keeps the stacked timestamp inside the author control, so one tap still opens actions', () => {
    const renderer = renderReplyItem({ depth: 3, authorId: 'u-bob', currentUserId: 'u-me' });
    const authorControl = renderer.root
      .findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Actions for'),
      )
      .find((n) => typeof n.props.onPress === 'function');
    expect(authorControl).toBeDefined();
    expect(
      authorControl!.findAll(
        (n) => typeof n.type === 'string' && n.props.children === POSTED_TEXT,
      ).length,
    ).toBeGreaterThan(0);
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
