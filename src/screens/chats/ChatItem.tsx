/**
 * Individual DM conversation row in the chats list.
 *
 * Shows avatar initial, recipient name, and timestamp.
 * Left 3px border matches the ThreadItem pattern.
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
import { Avatar } from '../../components/Avatar';

export interface ChatItemProps {
  conversationId: string;
  recipientName: string;
  lastMessageAt: number | null;
  avatarUrl?: string | null;
  onPress: (conversationId: string) => void;
}

function formatTime(timestamp: number | null): string {
  if (timestamp == null) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (messageDay.getTime() === today.getTime()) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (messageDay.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const ChatItem = React.memo(function ChatItem({
  conversationId,
  recipientName,
  lastMessageAt,
  avatarUrl,
  onPress,
}: ChatItemProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onPress(conversationId);
  }, [onPress, conversationId]);

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderSubtle,
    backgroundColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const mainStyle: ViewStyle = {
    flex: 1,
    marginLeft: theme.spacing.sm,
    marginRight: theme.spacing.sm,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const timeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${recipientName}`}
    >
      <Avatar
        name={recipientName}
        size={40}
        imageUrl={avatarUrl ?? undefined}
      />
      <View style={mainStyle}>
        <Text style={nameStyle} numberOfLines={1}>
          {recipientName}
        </Text>
      </View>
      {lastMessageAt != null && (
        <Text style={timeStyle}>{formatTime(lastMessageAt)}</Text>
      )}
    </TouchableOpacity>
  );
});
