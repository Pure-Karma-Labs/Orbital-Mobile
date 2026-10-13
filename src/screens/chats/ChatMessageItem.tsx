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

  /**
   * Both of this row's actions have to be declared here, because the row is a
   * bare `View` driven by an RNGH tap rather than a Touchable (#890 review):
   * TalkBack only dispatches ACTION_CLICK when `activate` is declared, and the
   * gesture handler never receives it. `ThreadItem` / `ChatItem` omit
   * `activate` precisely because they ARE Touchables, where the platform
   * already dispatches activation — that idiom does not transfer to this row.
   *
   * - `activate` opens the message, on EVERY row including your own. It is the
   *   screen-reader equivalent of the row tap, and also the backup route to
   *   Block/Report: ThreadDetail shows the same author's handle.
   * - `authorActions` opens Block/Report, and only on other people's rows.
   *
   * The container is `accessible` with role button, so iOS merges its children
   * and a screen reader cannot reach the handle inside it (#888).
   */
  const accessibilityActions = useMemo(
    () =>
      isSelf
        ? [{ name: 'activate' }]
        : [{ name: 'activate' }, { name: 'authorActions', label: `Actions for ${displayName}` }],
    [isSelf, displayName],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      switch (event.nativeEvent.actionName) {
        case 'activate':
          onPress(threadId);
          break;
        case 'authorActions':
          handleAuthorPress();
          break;
      }
    },
    [onPress, threadId, handleAuthorPress],
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

  // The author handle (#888): the name only, sized by its frame and never by
  // slop. Why, and the frame per surface: `docs/design/MOBILE-PATTERNS.md`
  // (touch targets). Local reason this one cannot be made smaller: in a DM the
  // handle is the ONLY route to Block/Report, the App Store 1.2 / Play UGC
  // safety control. The avatar, the time and the dot fall through to the row's
  // navigation tap. `stretch` takes the 24pt the avatar already sets, so the
  // row height is unchanged; the 44pt floor can extend the frame past a short
  // name, which shifts the time right and leaves that blank strip opening
  // Block/Report too (#890 review).
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
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
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
            <EmojiText style={authorStyle} numberOfLines={1}>
              {displayName}
            </EmojiText>
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
