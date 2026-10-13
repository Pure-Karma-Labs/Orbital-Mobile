/**
 * Thread header — renders the original post (level 0) at the top of the thread detail.
 *
 * Design spec: White background (surfaceElevated), borderStrong border,
 * 3px border radius, md padding, base horizontal margin.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { useContactAvatar } from '../../hooks/useContactAvatar';
import { EmojiText } from '../../components/EmojiText';
import { MediaGallery } from '../../components/MediaGallery';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';
import { MediaLightbox } from '../../components/MediaLightbox';
import { useMediaForThread } from '../../stores';
import { useAuthorActions } from '../../hooks/useAuthorActions';
import { useDisplayName } from '../../hooks/useDisplayName';
import { formatPostTimestamp, formatPostTimestampA11y } from '../../utils/formatPostTimestamp';

export interface ThreadHeaderProps {
  threadId: string;
  title: string | null;
  body: string | null;
  authorUsername: string;
  authorId: string;
  groupId: string;
  currentUserId: string | null;
  createdAt: number;
}

export const ThreadHeader = React.memo(function ThreadHeader({
  threadId,
  title,
  body,
  authorUsername,
  authorId,
  groupId,
  currentUserId,
  createdAt,
}: ThreadHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const displayName = useDisplayName(authorId, authorUsername);
  const avatarProps = useContactAvatar(authorId, groupId);
  const mediaItems = useMediaForThread(threadId);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const handleMediaPress = useCallback((index: number) => {
    setLightboxIndex(index);
    setLightboxVisible(true);
  }, []);

  const handleLightboxClose = useCallback(() => {
    setLightboxVisible(false);
  }, []);

  const authorContext = useMemo(() => ({
    contentType: 'thread' as const,
    contentId: threadId,
    groupId,
  }), [threadId, groupId]);
  const { handleAuthorPress } = useAuthorActions(authorId, authorUsername, currentUserId, authorContext);

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

  // The author handle (#888): the ONLY target that opens Block/Report, and it
  // covers the name alone — the avatar, the timestamp and the row's padding are
  // inert. Sized by a real frame, never by slop (`docs/design/MOBILE-PATTERNS.md`):
  // `stretch` takes the row height the 28pt avatar already sets, so nothing
  // grows, and `minWidth` 44 keeps a 1-character display name tappable.
  const authorHandleStyle: ViewStyle = {
    alignSelf: 'stretch',
    justifyContent: 'center',
    minWidth: 44,
    marginLeft: theme.spacing.sm,
    // The name yields, the date does not: a display-name fallback can be a
    // 64-char user id, and an absolute timestamp is always long enough that
    // an unshrinkable name would push it off screen entirely (#843 review).
    flexShrink: 1,
  };

  const authorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    // The gutter and the shrink budget live on the handle frame around it.
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

  const isSelf = authorId === currentUserId;

  return (
    <View style={containerStyle} testID="thread-header">
      {/*
        Passive row (#888). Only the name is a control; the avatar and the
        timestamp are siblings of it, not children, so tapping them does
        nothing at all.
      */}
      <View style={authorRowStyle}>
        {/*
          The avatar labels itself ("X avatar") and renders its initials as a
          host Text, so with the row no longer merged into one accessible
          element it would become its own screen-reader stop. The wrapper is
          layout-neutral: no style, so the 28pt avatar still sizes the row.
        */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Avatar name={displayName} size={28} {...avatarProps} />
        </View>
        <TouchableOpacity
          style={authorHandleStyle}
          onPress={handleAuthorPress}
          activeOpacity={isSelf ? 1 : 0.7}
          disabled={isSelf}
          accessibilityRole={isSelf ? undefined : 'button'}
          accessibilityLabel={isSelf ? undefined : `Actions for ${displayName}`}
          testID="thread-header-author-handle"
        >
          <EmojiText style={authorTextStyle} numberOfLines={1}>
            {displayName}
          </EmojiText>
        </TouchableOpacity>
        {/*
          Its own accessible element now that it is outside the control. Long
          form: "3:04 PM" read out of context is ambiguous, "September 12 at
          3:04 PM" is not (#821).
        */}
        <Text style={timestampStyle} accessibilityLabel={formatPostTimestampA11y(createdAt)}>
          {formatPostTimestamp(createdAt)}
        </Text>
      </View>
      {title != null && title.length > 0 && (
        <EmojiText style={titleStyle} selectable>{title}</EmojiText>
      )}
      {body != null && body.length > 0 && (
        <EmojiText style={bodyStyle} selectable>{body}</EmojiText>
      )}
      <LinkPreviewCard text={body} />
      {mediaItems.length > 0 && (
        <MediaGallery
          mediaItems={mediaItems}
          maxWidth={
            windowWidth
            - theme.spacing.base * 2   // horizontal margin
            - 2                         // border width (1px each side)
            - theme.spacing.md * 2     // padding
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
