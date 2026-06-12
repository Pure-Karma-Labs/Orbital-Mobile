/**
 * Flat DM message row — simplified display for chat-style conversations.
 *
 * Shows author, timestamp, and message body without thread structure
 * (no reply count, badges, or media indicators).
 */

import React, { useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { EmojiText } from '../../components/EmojiText';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';

export interface ChatMessageItemProps {
  threadId: string;
  body: string | null;
  author: string;
  time: string;
  isOwn: boolean;
  /**
   * Unread indicator — yellow accent border + dot (#329).
   * In DMs a row is a thread: it can be unread even if the local user
   * authored it (the other person replied). Self-flagging is prevented
   * upstream by markThreadViewed on post, not by authorship.
   */
  unread?: boolean;
  onPress: (threadId: string) => void;
}

export const ChatMessageItem = React.memo(function ChatMessageItem({
  threadId,
  body,
  author,
  time,
  isOwn,
  unread = false,
  onPress,
}: ChatMessageItemProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onPress(threadId);
  }, [onPress, threadId]);

  const containerStyle: ViewStyle = {
    flexDirection: 'column',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: unread
      ? theme.colors.yellow
      : isOwn
        ? theme.colors.blue
        : theme.colors.borderSubtle,
    backgroundColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const unreadDotStyle: TextStyle = {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.yellow,
    marginLeft: theme.spacing.xs,
  };

  const metaStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  };

  const authorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  const timeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginLeft: theme.spacing.xs,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * 1.45,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={unread ? `Unread message from ${author}` : `Message from ${author}`}
    >
      <View style={metaStyle}>
        <Text style={authorStyle} numberOfLines={1}>
          {author}
        </Text>
        <Text style={timeStyle}>{time}</Text>
        {unread && (
          <Text style={unreadDotStyle} testID={`chat-unread-dot-${threadId}`}>
            ●
          </Text>
        )}
      </View>
      {body ? (
        <EmojiText style={bodyStyle} numberOfLines={4}>
          {body}
        </EmojiText>
      ) : null}
      <LinkPreviewCard text={body} />
    </TouchableOpacity>
  );
});
