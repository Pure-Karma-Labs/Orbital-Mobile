/**
 * Individual thread row in the inbox list.
 *
 * Left border color and background tint vary by read state:
 *   read:   borderSubtle border, no tint
 *   active: blue border + blueTintLight background
 *   unread: purple border + purpleTintLight background
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
import { Badge } from '../../components/Badge';
import { Emoji } from '../../components/Emoji';
import { EmojiText } from '../../components/EmojiText';
import { Avatar } from '../../components/Avatar';
import { useContactAvatar } from '../../hooks/useContactAvatar';
import { useDisplayName } from '../../hooks/useDisplayName';
import { useIsMuted } from '../../hooks/useIsMuted';
import { ImportedIndicator } from '../import/ImportedBadge';

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
  /**
   * Mark the row as a Meta import (#927). A PRIMITIVE, like every other prop
   * here: this component is memoized, and an object or a node would make
   * `React.memo` useless for every visible row.
   */
  isImport?: boolean;
  /**
   * The spoken form of the import, folded into the row's accessibility label —
   * "imported from Facebook, June 1, 2014". The glyph itself is hidden from
   * screen readers, so this is the only thing that says it out loud.
   *
   * Built by the screen, not here: it carries the date in its long form, and
   * the row is handed the short one.
   */
  importA11y?: string;
  onPress: (threadId: string) => void;
  /**
   * Long press opens the mute/unmute menu (#449). Must be a stable reference —
   * this component is memoized and an unstable handler would re-render every
   * visible row on each parent render.
   */
  onLongPress?: (threadId: string) => void;
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
  isImport = false,
  importA11y,
  onPress,
  onLongPress,
}: ThreadItemProps): React.JSX.Element {
  const theme = useTheme();
  const displayName = useDisplayName(authorId, author);
  const avatarProps = useContactAvatar(authorId, groupId);
  const isMuted = useIsMuted(threadId);

  const handlePress = useCallback(() => {
    onPress(threadId);
  }, [onPress, threadId]);

  const handleLongPress = useCallback(() => {
    onLongPress?.(threadId);
  }, [onLongPress, threadId]);

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
      if (event.nativeEvent.actionName === 'mute') onLongPress?.(threadId);
    },
    [onLongPress, threadId],
  );

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

  // A gutter before the unread badge, so the two never touch when a row has
  // both. Nothing else: the glyph takes its own size from the component.
  const importedIndicatorStyle: ViewStyle = { marginRight: theme.spacing.xs };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={
        `Thread: ${title}` +
        (isImport && importA11y ? `, ${importA11y}` : '') +
        (isMuted ? ', muted' : '')
      }
      accessibilityHint={onLongPress ? 'Long press for notification options' : undefined}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onLongPress ? handleAccessibilityAction : undefined}
    >
      <Avatar name={displayName} size={32} {...avatarProps} />
      <View style={mainStyle}>
        {/*
          `linkify={false}` (#927): an imported post with no title shows its
          BODY here, which is often nothing but a link. A tappable link inside
          the row would sit on top of the row's own tap target, and a tap that
          landed on it would leave the app instead of opening the thread.
        */}
        <EmojiText style={titleStyle} numberOfLines={1} linkify={false}>
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
          {isMuted ? (
            <>
              {' '}
              <View style={{ width: emojiSize, height: emojiSize }} testID="thread-muted-indicator">
                <Emoji unified="1F515" size={emojiSize} />
              </View>
            </>
          ) : null}
        </Text>
      </View>
      {/*
        The import glyph sits in the row's RIGHT SLOT, outside the meta line
        (#927). Inside it, a long display name truncates the whole line and
        takes the glyph with it — the one row where the badge matters most is
        the one where it would disappear. Out here it is a sibling of the
        flexible main column, so it survives any name length, and it is not
        touchable: the row is the only tap target.
      */}
      {isImport && <ImportedIndicator style={importedIndicatorStyle} />}
      {unreadCount > 0 && <Badge count={unreadCount} />}
    </TouchableOpacity>
  );
});
