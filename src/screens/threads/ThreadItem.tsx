/**
 * Individual thread row in the inbox list.
 *
 * Left border color and background tint vary by read state:
 *   read:   borderSubtle border, no tint
 *   active: blue border + blueTintLight background
 *   unread: purple border + purpleTintLight background
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
import { Badge } from '../../components/Badge';
import { Emoji } from '../../components/Emoji';
import { EmojiText } from '../../components/EmojiText';
import { Avatar } from '../../components/Avatar';
import { useContactAvatar } from '../../hooks/useContactAvatar';
import { useDisplayName } from '../../hooks/useDisplayName';

export type ThreadItemState = 'read' | 'active' | 'unread';

export interface ThreadItemProps {
  threadId: string;
  title: string;
  authorId: string;
  author: string;
  groupId: string | null;
  time: string;
  replyCount: number;
  hasMedia?: boolean;
  state?: ThreadItemState;
  unreadCount?: number;
  onPress: (threadId: string) => void;
}

export const ThreadItem = React.memo(function ThreadItem({
  threadId,
  authorId,
  title,
  author,
  groupId,
  time,
  replyCount,
  hasMedia = false,
  state = 'read',
  unreadCount = 0,
  onPress,
}: ThreadItemProps): React.JSX.Element {
  const theme = useTheme();
  const displayName = useDisplayName(authorId, author);
  const avatarProps = useContactAvatar(authorId, groupId);

  const handlePress = useCallback(() => {
    onPress(threadId);
  }, [onPress, threadId]);

  // Derive left border color and background based on state
  let borderColor: string;
  let backgroundColor: string;
  switch (state) {
    case 'active':
      borderColor = theme.colors.blue;
      backgroundColor = theme.colors.blueTintLight;
      break;
    case 'unread':
      borderColor = theme.colors.purple;
      backgroundColor = theme.colors.purpleTintLight;
      break;
    default:
      borderColor = theme.colors.borderSubtle;
      backgroundColor = 'transparent';
  }

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: borderColor,
    backgroundColor,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const mainStyle: ViewStyle = {
    flex: 1,
    marginLeft: theme.spacing.sm,
    marginRight: theme.spacing.sm,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const metaStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: 2,
  };

  const emojiSize = Math.round(theme.typography.fontSize.sm * 1.15);

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Thread: ${title}`}
    >
      <Avatar name={displayName} size={32} {...avatarProps} />
      <View style={mainStyle}>
        <EmojiText style={titleStyle} numberOfLines={1}>
          {title}
        </EmojiText>
        <Text style={metaStyle} numberOfLines={1}>
          {displayName} {'·'} {time} {'·'} {replyCount}{' '}
          <View style={{ width: emojiSize, height: emojiSize }}>
            <Emoji unified="1F4AC" size={emojiSize} />
          </View>
          {hasMedia ? (
            <>
              {' '}
              <View style={{ width: emojiSize, height: emojiSize }}>
                <Emoji unified="1F4F7" size={emojiSize} />
              </View>
            </>
          ) : null}
        </Text>
      </View>
      {unreadCount > 0 && <Badge count={unreadCount} />}
    </TouchableOpacity>
  );
});
