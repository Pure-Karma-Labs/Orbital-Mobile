/**
 * Individual DM conversation row in the chats list.
 *
 * Shows avatar initial, recipient name, and timestamp.
 * Left 3px border matches the ThreadItem pattern.
 */

import React, { useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type AccessibilityActionEvent,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Emoji } from '../../components/Emoji';
import { EmojiText } from '../../components/EmojiText';
import { useIsMuted } from '../../hooks/useIsMuted';

export interface ChatItemProps {
  conversationId: string;
  recipientName: string;
  lastMessageAt: number | null;
  avatarUrl?: string | null;
  unreadCount?: number;
  onPress: (conversationId: string) => void;
  /**
   * Long press opens the mute/unmute menu (#449). Must be a stable reference —
   * this component is memoized.
   */
  onLongPress?: (conversationId: string) => void;
  /** User ID — required for encrypted avatar resolution */
  userId?: string | null;
  /** Group ID for group key lookup */
  groupId?: string | null;
  /** Encrypted avatar attachment key (base64) */
  encryptedAvatarKey?: string | null;
  /** IV for avatar key decryption (base64) */
  avatarKeyIv?: string | null;
  /** SHA-256 digest of encrypted avatar blob (base64) */
  avatarDigest?: string | null;
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
  unreadCount,
  onPress,
  onLongPress,
  userId,
  groupId,
  encryptedAvatarKey,
  avatarKeyIv,
  avatarDigest,
}: ChatItemProps): React.JSX.Element {
  const theme = useTheme();
  const isMuted = useIsMuted(conversationId);

  const handlePress = useCallback(() => {
    onPress(conversationId);
  }, [onPress, conversationId]);

  const handleLongPress = useCallback(() => {
    onLongPress?.(conversationId);
  }, [onLongPress, conversationId]);

  // Screen readers can't long-press: expose the same action explicitly.
  const accessibilityActions = useMemo(
    () =>
      onLongPress
        ? [{ name: 'mute', label: isMuted ? 'Unmute notifications' : 'Mute notifications' }]
        : undefined,
    [onLongPress, isMuted],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'mute') onLongPress?.(conversationId);
    },
    [onLongPress, conversationId],
  );

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
    // Shrink rather than push the muted glyph out of the row.
    flexShrink: 1,
  };

  const nameRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
  };

  const mutedIconStyle: ViewStyle = {
    marginLeft: theme.spacing.xs,
  };

  const emojiSize = Math.round(theme.typography.fontSize.sm * 1.15);

  const timeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${recipientName}${isMuted ? ', muted' : ''}`}
      accessibilityHint={onLongPress ? 'Long press for notification options' : undefined}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onLongPress ? handleAccessibilityAction : undefined}
    >
      <Avatar
        name={recipientName}
        size={40}
        imageUrl={avatarUrl ?? undefined}
        userId={userId}
        groupId={groupId}
        encryptedAvatarKey={encryptedAvatarKey}
        avatarKeyIv={avatarKeyIv}
        avatarDigest={avatarDigest}
      />
      <View style={mainStyle}>
        <View style={nameRowStyle}>
          <EmojiText style={nameStyle} numberOfLines={1}>
            {recipientName}
          </EmojiText>
          {isMuted && (
            <View style={mutedIconStyle} testID="chat-muted-indicator">
              <Emoji unified="1F515" size={emojiSize} />
            </View>
          )}
        </View>
      </View>
      {lastMessageAt != null && (
        <Text style={timeStyle}>{formatTime(lastMessageAt)}</Text>
      )}
      {unreadCount != null && unreadCount > 0 && (
        <Badge count={unreadCount} testID="unread-badge" />
      )}
    </TouchableOpacity>
  );
});
