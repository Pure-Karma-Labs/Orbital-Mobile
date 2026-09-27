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
  /** When true, renders a brief highlight overlay (notification deep-link target) */
  isHighlighted?: boolean;
}

/** Format a timestamp as a relative or absolute time string */
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

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
  parentAuthorId,
  parentAuthorUsername,
  onReplyPress,
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

  const authorRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    // Yield width to the fixed-size arrow instead of pushing it off-screen.
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
    marginLeft: theme.spacing.sm,
    flexShrink: 0,
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
        Text only in PR1 — the jump control lands in PR2. 'hidden' deliberately
        names nobody: the parent's author is blocked, and the old
        `@${parentDisplayName}` line leaked their username back onto the screen.
      */}
      {parentState !== 'none' && (
        <EmojiText style={replyContextStyle} testID={`reply-item-${replyId}-parent-context`}>
          {parentState === 'orphan'
            ? '↳ Replying to an earlier reply'
            : parentState === 'hidden'
              ? '↳ Replying to a hidden reply'
              : `↳ Replying to @${parentDisplayName}`}
        </EmojiText>
      )}
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
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 0 }}
          accessibilityRole={isSelf ? undefined : 'button'}
          // The timestamp is inside this control, so it is invisible to a
          // screen reader unless the label carries it.
          accessibilityLabel={
            isSelf ? undefined : `Actions for ${displayName}, posted ${formatTimestamp(createdAt)}`
          }
        >
          <Avatar name={displayName} size={20} {...avatarProps} />
          <EmojiText style={authorTextStyle} numberOfLines={1}>{displayName}</EmojiText>
          <Text style={timestampStyle}>{formatTimestamp(createdAt)}</Text>
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
