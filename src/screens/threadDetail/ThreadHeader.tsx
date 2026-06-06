/**
 * Thread header — renders the original post (level 0) at the top of the thread detail.
 *
 * Design spec: White background (surfaceElevated), borderStrong border,
 * 3px border radius, md padding, base horizontal margin.
 */

import React, { useCallback, useState } from 'react';
import { Alert, Dimensions, Linking, View, Text, TouchableOpacity, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { EmojiText } from '../../components/EmojiText';
import { MediaGallery } from '../../components/MediaGallery';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';
import { MediaLightbox } from '../../components/MediaLightbox';
import { useMediaForThread } from '../../stores';
import { useAppStore } from '../../stores/useAppStore';

const REPORT_EMAIL = 'report@orbitl.org';

export interface ThreadHeaderProps {
  threadId: string;
  title: string | null;
  body: string | null;
  authorUsername: string;
  authorId: string;
  currentUserId: string | null;
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
  threadId,
  title,
  body,
  authorUsername,
  authorId,
  currentUserId,
  createdAt,
}: ThreadHeaderProps): React.JSX.Element {
  const theme = useTheme();
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

  const handleReport = useCallback(() => {
    const subject = 'Content Report — Orbital';
    const reportBody = `Reporting user: @${authorUsername}\n\nNote: Orbital uses end-to-end encryption, so we cannot view message content. Please describe the issue below.\n\n---\n`;
    const mailto = `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportBody)}`;
    Linking.canOpenURL(mailto).then((supported) => {
      if (supported) {
        Linking.openURL(mailto);
      } else {
        Alert.alert(
          'Send Report',
          `Email ${REPORT_EMAIL} with details about this user.`,
          [{ text: 'OK' }],
        );
      }
    });
  }, [authorUsername]);

  const handleAuthorPress = useCallback(() => {
    // Don't show action sheet for self
    if (authorId === currentUserId) return;

    Alert.alert(authorUsername, '', [
      {
        text: 'Block',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            `Block @${authorUsername}?`,
            'You will no longer see their posts or replies.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                onPress: () => useAppStore.getState().blockUser(authorId, authorUsername),
              },
            ],
          );
        },
      },
      { text: 'Report', onPress: handleReport },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [authorId, currentUserId, authorUsername, handleReport]);

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

  const isSelf = authorId === currentUserId;

  return (
    <View style={containerStyle} testID="thread-header">
      <TouchableOpacity
        style={authorRowStyle}
        onPress={handleAuthorPress}
        activeOpacity={isSelf ? 1 : 0.7}
        disabled={isSelf}
        accessibilityRole={isSelf ? undefined : 'button'}
        accessibilityLabel={isSelf ? undefined : `Actions for ${authorUsername}`}
      >
        <Avatar name={authorUsername} size={28} />
        <Text style={authorTextStyle}>{authorUsername}</Text>
        <Text style={timestampStyle}>{formatTimestamp(createdAt)}</Text>
      </TouchableOpacity>
      {title != null && title.length > 0 && (
        <Text style={titleStyle}>{title}</Text>
      )}
      {body != null && body.length > 0 && (
        <EmojiText style={bodyStyle}>{body}</EmojiText>
      )}
      <LinkPreviewCard text={body} />
      {mediaItems.length > 0 && (
        <MediaGallery
          mediaItems={mediaItems}
          maxWidth={
            Dimensions.get('window').width
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
