/**
 * Thread header — renders the original post (level 0) at the top of the thread detail.
 *
 * Design spec: White background (surfaceElevated), borderStrong border,
 * 3px border radius, md padding, base horizontal margin.
 */

import React from 'react';
import { View, Text, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { EmojiText } from '../../components/EmojiText';

export interface ThreadHeaderProps {
  title: string | null;
  body: string | null;
  authorUsername: string;
  createdAt: number;
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
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const ThreadHeader = React.memo(function ThreadHeader({
  title,
  body,
  authorUsername,
  createdAt,
}: ThreadHeaderProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.md,
    marginHorizontal: theme.spacing.base,
    marginTop: theme.spacing.base,
    marginBottom: theme.spacing.sm,
  };

  const authorRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  };

  const authorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginLeft: theme.spacing.sm,
  };

  const timestampStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    letterSpacing: theme.typography.letterSpacing.tight,
    marginLeft: theme.spacing.sm,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.relaxed,
  };

  return (
    <View style={containerStyle} testID="thread-header">
      <View style={authorRowStyle}>
        <Avatar name={authorUsername} size={28} />
        <Text style={authorTextStyle}>{authorUsername}</Text>
        <Text style={timestampStyle}>{formatTimestamp(createdAt)}</Text>
      </View>
      {title != null && title.length > 0 && (
        <Text style={titleStyle}>{title}</Text>
      )}
      {body != null && body.length > 0 && (
        <EmojiText style={bodyStyle}>{body}</EmojiText>
      )}
    </View>
  );
});
