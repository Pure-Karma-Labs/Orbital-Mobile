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
 */

import React, { useCallback } from 'react';
import { Text, TouchableOpacity, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { getReplyDepthColors } from '../../theme/colors';
import { EmojiText } from '../../components/EmojiText';

export interface ReplyItemProps {
  replyId: string;
  body: string | null;
  authorUsername: string;
  depth: number;
  createdAt: number;
  syncStatus: 'synced' | 'pending' | 'syncing' | 'failed';
  /** Username of the parent reply author, or null for top-level replies */
  parentAuthorUsername: string | null;
  /** Called when the reply is tapped (to set it as reply-to target) */
  onPress: (replyId: string, authorUsername: string, depth: number) => void;
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
  depth,
  createdAt,
  syncStatus,
  parentAuthorUsername,
  onPress,
}: ReplyItemProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onPress(replyId, authorUsername, depth);
  }, [onPress, replyId, authorUsername, depth]);

  // displayDepth: offset by 1 because depth 0 in replies = level 1 visually
  // (level 0 is the original post rendered by ThreadHeader)
  const displayDepth = Math.min(depth + 1, 4);
  const depthColors = getReplyDepthColors(theme.colors);
  const depthColor = depthColors[displayDepth];

  const leftMargin = theme.threadIndent.perLevel * Math.min(depth, 4);

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

  const authorRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
  };

  const authorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const timestampStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    letterSpacing: theme.typography.letterSpacing.tight,
    marginLeft: theme.spacing.sm,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.relaxed,
    marginTop: theme.spacing.xs,
  };

  const failedStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.error,
    marginTop: theme.spacing.xs,
  };

  const replyContextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.xs,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Reply by ${authorUsername}`}
      testID={`reply-item-${replyId}`}
    >
      {parentAuthorUsername != null && (
        <Text style={replyContextStyle}>{`↳ Replying to @${parentAuthorUsername}`}</Text>
      )}
      <View style={authorRowStyle}>
        <Text style={authorTextStyle}>{authorUsername}</Text>
        <Text style={timestampStyle}>{formatTimestamp(createdAt)}</Text>
      </View>
      {body != null && body.length > 0 && (
        <EmojiText style={bodyStyle}>{body}</EmojiText>
      )}
      {syncStatus === 'failed' && (
        <Text style={failedStyle}>Failed to send</Text>
      )}
    </TouchableOpacity>
  );
});
