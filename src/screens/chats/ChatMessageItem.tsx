/**
 * Flat DM message row — simplified display for chat-style conversations.
 *
 * Shows author, timestamp, and message body without thread structure
 * (no reply count, badges, or media indicators).
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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { EmojiText } from '../../components/EmojiText';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';
import { useContactAvatar } from '../../hooks/useContactAvatar';
import { useDisplayName } from '../../hooks/useDisplayName';
import { useAuthorActions } from '../../hooks/useAuthorActions';
import { useAuth } from '../../stores';

export interface ChatMessageItemProps {
  threadId: string;
  authorId: string;
  body: string | null;
  author: string;
  groupId: string | null;
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
  authorId,
  body,
  author,
  groupId,
  time,
  isOwn,
  unread = false,
  onPress,
}: ChatMessageItemProps): React.JSX.Element {
  const theme = useTheme();
  const { userId } = useAuth();
  const displayName = useDisplayName(authorId, author);
  const avatarProps = useContactAvatar(authorId, groupId);
  const authorContext = useMemo(() => ({
    contentType: 'message' as const,
    contentId: threadId,
    groupId: groupId ?? undefined,
  }), [threadId, groupId]);
  const { handleAuthorPress } = useAuthorActions(authorId, displayName, userId, authorContext);
  const isSelf = authorId === userId;

  // The container is `accessible` with role button, so iOS merges its children
  // and a screen reader cannot reach the handle inside it. A custom action is
  // the only route (#888). Deliberately NO 'activate' action: activation keeps
  // today's behaviour (open the message), and declaring it would duplicate the
  // navigation push — matching the in-repo idiom in ThreadItem / ChatItem.
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'authorActions') handleAuthorPress();
    },
    [handleAuthorPress],
  );

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .onEnd(() => {
          onPress(threadId);
        })
        .runOnJS(true),
    [onPress, threadId],
  );

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

  const authorRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  };

  const unreadDotStyle: TextStyle = {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.yellow,
    marginLeft: theme.spacing.xs,
  };

  // The author handle (#888): the ONLY target that opens Block/Report, and in a
  // DM it is the only route to it at all — the App Store 1.2 / Play UGC safety
  // control, so it has to stay reachable. It covers the name alone; the avatar,
  // the time and the unread dot fall through to the row's navigation tap.
  // Sized by a real frame, never by slop (`docs/design/MOBILE-PATTERNS.md`):
  // `stretch` takes the row height the 24pt avatar already sets, so nothing
  // grows, and `minWidth` 44 keeps a 1-character display name tappable.
  const authorHandleStyle: ViewStyle = {
    alignSelf: 'stretch',
    justifyContent: 'center',
    minWidth: 44,
    marginLeft: theme.spacing.xs,
  };

  const authorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
    // The gutter lives on the handle frame around it. No flexShrink: the name
    // does not shrink today either, so truncation behaviour is unchanged.
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
    <GestureDetector gesture={tapGesture}>
      <View
        style={containerStyle}
        accessible
        accessibilityRole="button"
        accessibilityLabel={unread ? `Unread message from ${displayName}` : `Message from ${displayName}`}
        accessibilityActions={
          isSelf ? undefined : [{ name: 'authorActions', label: `Actions for ${displayName}` }]
        }
        onAccessibilityAction={isSelf ? undefined : handleAccessibilityAction}
      >
        {/*
          Passive row (#888): only the name is a control. A tap on the avatar,
          the time, the dot or the gaps now falls through to the row's
          Gesture.Tap and opens the message — the harmless direction.
        */}
        <View style={authorRowStyle}>
          <Avatar name={displayName} size={24} {...avatarProps} />
          <TouchableOpacity
            style={authorHandleStyle}
            onPress={handleAuthorPress}
            activeOpacity={isSelf ? 1 : 0.7}
            disabled={isSelf}
            accessibilityRole={isSelf ? undefined : 'button'}
            accessibilityLabel={isSelf ? undefined : `Actions for ${displayName}`}
            testID={`chat-message-${threadId}-author-handle`}
          >
            <Text style={authorStyle} numberOfLines={1}>
              {displayName}
            </Text>
          </TouchableOpacity>
          <Text style={timeStyle}>{time}</Text>
          {unread && (
            <Text style={unreadDotStyle} testID={`chat-unread-dot-${threadId}`}>
              ●
            </Text>
          )}
        </View>
        {body ? (
          // Deliberately NOT selectable (#518): this row's tap is navigation, so
          // a long press here would only contest it — copy the full text in ThreadDetail.
          <EmojiText style={bodyStyle} numberOfLines={4}>
            {body}
          </EmojiText>
        ) : null}
        <LinkPreviewCard text={body} />
      </View>
    </GestureDetector>
  );
});
