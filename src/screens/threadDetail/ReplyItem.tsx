/**
 * Single reply row in the thread detail list.
 *
 * Depth-based visual treatment:
 * - Left margin: threadIndent.perLevel (24) * Math.min(depth, 4)
 * - Left border: 3px with depth color
 * - Background: tinted by depth color
 *
 * Depth color mapping (from getReplyDepthColors):
 *   depth 0 (top-level reply) -> index 1 (blue tint, blue border)
 *   depth 1                   -> index 2 (purple tint, purple border)
 *   depth 2                   -> index 3 (blue tint stronger, blue border)
 *   depth 3+                  -> index 4 (purple tint stronger, purple border)
 *
 * The original post (level 0) is rendered by ThreadHeader, so replies
 * use displayDepth = depth + 1 for color lookup (clamped to 4).
 *
 * Touch model (#518): the row container is passive — no tap, no a11y role.
 * Replying is an explicit ↩️ arrow at the right of the header row; the body
 * stays `selectable` with nothing competing for the long press, and a tap on
 * a link or an image no longer sets a reply target as a side effect.
 *
 * The row has exactly three touch targets (#821), stacked top to bottom with
 * no overlap: the "↳ Replying to @x" jump control, the author control (block /
 * report), and the reply arrow — plus the collapse toggle under the body when
 * the row has descendants. The author control carries NO top slop, so a
 * near-miss below the context line can never open the Block/Report sheet.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { getReplyDepthColors } from '../../theme/colors';
import { Avatar } from '../../components/Avatar';
import { Emoji } from '../../components/Emoji';
import { EmojiText } from '../../components/EmojiText';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';
import { MediaGallery } from '../../components/MediaGallery';
import { MediaLightbox } from '../../components/MediaLightbox';
import { useMediaForReply } from '../../stores';
import { useAuthorActions } from '../../hooks/useAuthorActions';
import { useContactAvatar } from '../../hooks/useContactAvatar';
import { useDisplayName } from '../../hooks/useDisplayName';
import { formatPostTimestamp, formatPostTimestampA11y } from '../../utils/formatPostTimestamp';
import type { ParentState } from '../../utils/replyTree';



export interface ReplyItemProps {
  replyId: string;
  body: string | null;
  authorUsername: string;
  authorId: string;
  groupId: string | null;
  currentUserId: string | null;
  depth: number;
  createdAt: number;
  syncStatus: 'synced' | 'pending' | 'syncing' | 'failed';
  /**
   * What the "↳ Replying to …" context line should say (#821). Computed by
   * `replyTree.ts` from the loaded tree, not from this row alone:
   * - `none`     — top-level reply; no context line.
   * - `jumpable` — the parent is loaded and on screen: show its name.
   * - `orphan`   — the parent is not loaded (a later page, or removed).
   * - `hidden`   — the parent's author is blocked; never name them.
   */
  parentState: ParentState;
  /** Parent reply id — only set (and only jumpable) when parentState is 'jumpable' */
  parentId: string | null;
  /** ID of the parent reply author — only set when parentState is 'jumpable' */
  parentAuthorId: string | null;
  /** Username fallback of the parent reply author — 'jumpable' only */
  parentAuthorUsername: string | null;
  /**
   * Called when the row's reply arrow is pressed (to set this reply as the
   * reply-to target). There is no whole-row tap: the body stays selectable
   * and only the explicit arrow control replies (#518).
   */
  onReplyPress: (replyId: string, authorUsername: string, depth: number) => void;
  /** Called when the "↳ Replying to @x" control is pressed — scrolls to the parent. */
  onParentPress: (parentId: string) => void;
  /** Descendants of this row that are actually rendered (blocked authors excluded). */
  visibleDescendants: number;
  /** True when this row's subtree is hidden by the collapse toggle. */
  collapsed: boolean;
  /** Called when the collapse toggle is pressed. */
  onToggleCollapse: (replyId: string) => void;
  /** When true, renders a brief highlight overlay (notification deep-link target) */
  isHighlighted?: boolean;
}

/**
 * Depth at which the timestamp moves to a second line under the author name.
 *
 * Measured against the real budget, not guessed. Usable row width is
 * `W - 16 (left margin) - 24*min(depth,4) (indent) - 3 (border) - 24 (padding)
 * - 16 (right margin)`, and the single-line header spends a fixed
 * `20 (avatar) + 4 + 8 + 44 (reply arrow)` on chrome plus the timestamp.
 * "Sep 12, 3:04 PM" is 15 mono-10 chars ≈ 92pt; a past-year stamp is ≈ 128pt.
 * What is left for the name at 375pt: d0 148pt (~18 chars), d1 124pt (~15),
 * d2 100pt (~12), d3 76pt (~9), d4 52pt (~6) — and 8 / 5 / 2 chars once the
 * stamp carries a year. Depth 0-1 still fit a normal name on one line, so
 * keeping the denser top of the thread compact is worth it; from depth 2 the
 * name is being truncated to nothing, so the stamp gets its own line (which
 * hands the name the full 100-152pt back).
 */
const TWO_LINE_TIMESTAMP_DEPTH = 2;

export const ReplyItem = React.memo(function ReplyItem({
  replyId,
  body,
  authorUsername,
  authorId,
  groupId,
  currentUserId,
  depth,
  createdAt,
  syncStatus,
  parentState,
  parentId,
  parentAuthorId,
  parentAuthorUsername,
  onReplyPress,
  onParentPress,
  visibleDescendants,
  collapsed,
  onToggleCollapse,
  isHighlighted,
}: ReplyItemProps): React.JSX.Element {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const displayName = useDisplayName(authorId, authorUsername);
  const avatarProps = useContactAvatar(authorId, groupId);
  const parentDisplayName = useDisplayName(parentAuthorId, parentAuthorUsername ?? '');
  const mediaItems = useMediaForReply(replyId);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const canReply = syncStatus === 'synced';

  const handleReplyPress = useCallback(() => {
    // LOAD-BEARING: this in-handler check — not `disabled` — is the enforced
    // #749 guard. A pending row is intentionally inert: its clientId is never a
    // valid parentReplyId, so letting it become the reply target would post a
    // reply parented to an id the server has never seen. Tests (and anything
    // else that invokes props.onPress directly) bypass `disabled` entirely, so
    // this must never be deleted as redundant with the prop.
    if (!canReply) return;
    onReplyPress(replyId, displayName, depth);
  }, [canReply, onReplyPress, replyId, displayName, depth]);

  const handleParentPress = useCallback(() => {
    // Mirrors the #749 guard on the arrow: the id is only a valid scroll target
    // while the parent is loaded and rendered, which is exactly `jumpable`.
    if (parentState !== 'jumpable' || !parentId) return;
    onParentPress(parentId);
  }, [parentState, parentId, onParentPress]);

  const handleToggleCollapse = useCallback(() => {
    onToggleCollapse(replyId);
  }, [onToggleCollapse, replyId]);

  const handleMediaPress = useCallback((index: number) => {
    setLightboxIndex(index);
    setLightboxVisible(true);
  }, []);

  const handleLightboxClose = useCallback(() => {
    setLightboxVisible(false);
  }, []);

  const authorContext = useMemo(() => ({
    contentType: 'reply' as const,
    contentId: replyId,
    groupId: groupId ?? undefined,
  }), [replyId, groupId]);
  const { handleAuthorPress } = useAuthorActions(authorId, authorUsername, currentUserId, authorContext);

  // displayDepth: offset by 1 because depth 0 in replies = level 1 visually
  // (level 0 is the original post rendered by ThreadHeader)
  const displayDepth = Math.min(depth + 1, 4);
  const depthColors = getReplyDepthColors(theme.colors);
  const depthColor = depthColors[displayDepth];

  const leftMargin = theme.threadIndent.perLevel * Math.min(depth, 4);
  const isSelf = authorId === currentUserId;

  // Absolute date + time everywhere (#821): "5m ago" on a reply you are
  // reading three days later tells you nothing, and the thread tree is no
  // longer chronological, so relative stamps actively mislead.
  const timestampText = formatPostTimestamp(createdAt);
  const timestampA11y = formatPostTimestampA11y(createdAt);

  const canCollapse = visibleDescendants > 0;
  const replyNoun = visibleDescendants === 1 ? 'reply' : 'replies';

  const containerStyle: ViewStyle = {
    backgroundColor: depthColor.background,
    borderLeftWidth: 3,
    borderLeftColor: depthColor.border,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.md,
    marginLeft: theme.spacing.base + leftMargin,
    marginRight: theme.spacing.base,
    marginTop: theme.spacing.sm,
    opacity: syncStatus === 'pending' || syncStatus === 'syncing' ? 0.7 : 1,
  };

  // Outer header row: author control + reply arrow as SIBLINGS.
  const headerRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
  };

  const stackTimestamp = depth >= TWO_LINE_TIMESTAMP_DEPTH;

  const authorRowStyle: ViewStyle = {
    flexDirection: 'row',
    // Stacked: the avatar aligns with the NAME, not with the centre of a
    // two-line block, so it doesn't float beside the timestamp.
    alignItems: stackTimestamp ? 'flex-start' : 'center',
    // Yield width to the fixed-size arrow instead of pushing it off-screen.
    flexShrink: 1,
    minWidth: 0,
  };

  const nameColumnStyle: ViewStyle = {
    marginLeft: theme.spacing.xs,
    flexShrink: 1,
    minWidth: 0,
  };

  const replyButtonStyle: ViewStyle = {
    // Sized by its own frame, not by slop: slop does not enlarge the visual
    // target and does not survive overflow clipping on Android.
    minWidth: 44,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
    flexShrink: 0,
    // Stays rendered when it can't be used, so syncing causes no layout shift.
    opacity: canReply ? 1 : 0.5,
  };

  const authorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginLeft: theme.spacing.xs,
    flexShrink: 1,
  };

  const timestampStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    letterSpacing: theme.typography.letterSpacing.tight,
    // Stacked, the stamp sits under the name and needs no gutter; inline it
    // needs one, and must never shrink (a clipped date is worse than a
    // clipped name, which at least has an avatar next to it).
    marginLeft: stackTimestamp ? 0 : theme.spacing.sm,
    flexShrink: 0,
  };

  const stackedAuthorTextStyle: TextStyle = {
    ...authorTextStyle,
    // The column owns the gutter now.
    marginLeft: 0,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.relaxed,
    marginTop: theme.spacing.xs,
  };

  const replyContextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.xs,
  };

  // Jumpable only. 32pt frame (the text itself is ~13pt tall) + 8pt vertical
  // slop = a 48pt effective target. NO horizontal slop: left slop would hang
  // outside the card, and right slop would reach across the row.
  const replyContextButtonStyle: ViewStyle = {
    minHeight: 32,
    justifyContent: 'center',
    // No extra bottom margin: the 32pt frame already centres ~13pt of text, so
    // it contributes the gap the plain text variant gets from marginBottom.
    marginBottom: 0,
  };

  const jumpableContextStyle: TextStyle = {
    ...replyContextStyle,
    color: theme.colors.blue,
    marginBottom: 0,
  };

  const collapseToggleStyle: ViewStyle = {
    // Same sizing rule as the reply arrow: a real frame, not slop. Slop does
    // not enlarge the visual target and is clipped by overflow on Android.
    minWidth: 44,
    minHeight: 32,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: theme.spacing.xs,
  };

  const collapseToggleTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    letterSpacing: theme.typography.letterSpacing.tight,
  };

  return (
    // No container tap and no container a11y role (#518): the row is a passive
    // surface so long-press text selection in the body is uncontested, and the
    // only reply affordance is the explicit arrow below.
    <View style={containerStyle} testID={`reply-item-${replyId}`}>
      {isHighlighted && (
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: theme.colors.blue,
            opacity: 0.15,
            borderRadius: theme.borderRadius.base,
          }}
          pointerEvents="none"
        />
      )}
      {/*
        Only a 'jumpable' parent is touchable — the other two states name no
        destination. 'hidden' also deliberately names nobody: the parent's
        author is blocked, and the old `@${parentDisplayName}` line leaked
        their username back onto the screen.
      */}
      {parentState === 'jumpable' && parentId ? (
        <TouchableOpacity
          style={replyContextButtonStyle}
          onPress={handleParentPress}
          // Vertical only. The author control below carries top: 0 slop for
          // the same reason: these two stack with no gap, and whichever one
          // reaches into the other would steal its taps — a near-miss here
          // must never open the Block/Report sheet.
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
          accessibilityRole="button"
          accessibilityLabel={`Go to @${parentDisplayName}'s reply`}
          testID={`reply-item-${replyId}-parent-jump`}
        >
          <EmojiText
            style={jumpableContextStyle}
            numberOfLines={1}
            testID={`reply-item-${replyId}-parent-context`}
          >
            {`↳ Replying to @${parentDisplayName}`}
          </EmojiText>
        </TouchableOpacity>
      ) : parentState !== 'none' ? (
        <EmojiText style={replyContextStyle} testID={`reply-item-${replyId}-parent-context`}>
          {parentState === 'orphan'
            ? '↳ Replying to an earlier reply'
            : parentState === 'hidden'
              ? '↳ Replying to a hidden reply'
              : `↳ Replying to @${parentDisplayName}`}
        </EmojiText>
      ) : null}
      <View style={headerRowStyle}>
        {/*
          Two SIBLING touchables. The arrow must never nest inside the author
          touchable, which is disabled={isSelf} — nesting would kill reply on
          your own rows. The arrow also renders last on purpose: if the two
          hit regions ever overlap, the later sibling wins and the benign
          control (reply) takes the touch, not the block/report sheet.
        */}
        <TouchableOpacity
          style={authorRowStyle}
          onPress={handleAuthorPress}
          activeOpacity={isSelf ? 1 : 0.7}
          disabled={isSelf}
          // right: 0 — any right slop here reaches into the arrow's frame once
          // the name is long enough to close the gap, so a near-miss left of
          // the arrow would open the Block/Report sheet instead.
          // top: 0 — the context line's own 8pt bottom slop sits directly
          // above this row (#821); top slop here would contest it, and the
          // destructive control must lose that argument by construction.
          hitSlop={{ top: 0, bottom: 4, left: 4, right: 0 }}
          accessibilityRole={isSelf ? undefined : 'button'}
          // The timestamp is inside this control, so it is invisible to a
          // screen reader unless the label carries it. Long form: "3:04 PM"
          // read out of context is ambiguous, "September 12 at 3:04 PM" is not.
          accessibilityLabel={
            isSelf ? undefined : `Actions for ${displayName}, posted ${timestampA11y}`
          }
        >
          <Avatar name={displayName} size={20} {...avatarProps} />
          {stackTimestamp ? (
            <View style={nameColumnStyle}>
              <EmojiText style={stackedAuthorTextStyle} numberOfLines={1}>{displayName}</EmojiText>
              <Text style={timestampStyle}>{timestampText}</Text>
            </View>
          ) : (
            <>
              <EmojiText style={authorTextStyle} numberOfLines={1}>{displayName}</EmojiText>
              <Text style={timestampStyle}>{timestampText}</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={replyButtonStyle}
          onPress={handleReplyPress}
          disabled={!canReply}
          // No LEFT slop: slop on that edge would sit over the timestamp and
          // steal taps meant for the author control.
          hitSlop={{ top: 8, bottom: 8, right: 8, left: 0 }}
          accessibilityRole="button"
          accessibilityLabel={`Reply to ${displayName}`}
          accessibilityState={{ disabled: !canReply }}
          testID={`reply-item-${replyId}-reply-button`}
        >
          {/*
            The 21A9-FE0F raster is entirely black (max channel 77), so
            untinted it sits at ~1.4:1 on a dark reply row. It is monochrome,
            so tinting is lossless and gives the control a themed colour.
          */}
          <Emoji unified="21A9-FE0F" size={16} tintColor={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {body != null && body.length > 0 && (
        <EmojiText style={bodyStyle} selectable>{body}</EmojiText>
      )}
      <LinkPreviewCard text={body} />
      {mediaItems.length > 0 && (
        <MediaGallery
          mediaItems={mediaItems}
          maxWidth={
            windowWidth
            - theme.spacing.base          // left outer margin
            - leftMargin                   // depth indentation
            - 3                            // left border width
            - theme.spacing.md * 2         // left + right padding
            - theme.spacing.base           // right outer margin
          }
          onItemPress={handleMediaPress}
        />
      )}
      {canCollapse && (
        <TouchableOpacity
          style={collapseToggleStyle}
          onPress={handleToggleCollapse}
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${visibleDescendants} ${replyNoun} to ${displayName}`}
          testID={`reply-item-${replyId}-collapse-toggle`}
        >
          <Text style={collapseToggleTextStyle}>
            {collapsed
              ? `[+] ${visibleDescendants} ${replyNoun}`
              : `[–] hide ${visibleDescendants} ${replyNoun}`}
          </Text>
        </TouchableOpacity>
      )}
      {mediaItems.length > 0 && (
        <MediaLightbox
          visible={lightboxVisible}
          mediaItems={mediaItems}
          initialIndex={lightboxIndex}
          onClose={handleLightboxClose}
        />
      )}
    </View>
  );
});
