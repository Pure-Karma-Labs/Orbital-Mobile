/**
 * MediaThumbnailStrip -- horizontal scrollable strip of media thumbnails.
 *
 * Each thumbnail is a 72x72 rounded Image with an X remove button overlay.
 * Video items show a dark tile with a duration label instead of an Image.
 * Optional upload progress overlay per thumbnail (circular indicator).
 *
 * Used in ComposeThreadScreen and ReplyComposer for showing selected media
 * before posting.
 */

import React from 'react';
import {
  Image,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import type { PickedMedia } from '../hooks/useMediaPicker';
import { formatDurationSeconds } from '../utils/formatDuration';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaThumbnailStripProps {
  /** Array of selected media to display */
  media: PickedMedia[];
  /** Upload progress per media index (0-1). When present, shows progress overlay. */
  uploadProgress?: Record<number, number>;
  /** Called when the user taps the X button on a thumbnail */
  onRemove: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THUMBNAIL_SIZE = 72;
const REMOVE_BUTTON_SIZE = 22;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaThumbnailStrip({
  media,
  uploadProgress,
  onRemove,
}: MediaThumbnailStripProps): React.JSX.Element | null {
  const theme = useTheme();

  if (media.length === 0) return null;

  const containerStyle: ViewStyle = {
    paddingVertical: theme.spacing.xs,
  };

  const scrollContentStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  };

  const thumbnailWrapperStyle: ViewStyle = {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: theme.borderRadius.base,
    overflow: 'hidden',
    position: 'relative',
  };

  const imageStyle = {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
  };

  const removeButtonStyle: ViewStyle = {
    position: 'absolute',
    top: 4,
    right: 4,
    width: REMOVE_BUTTON_SIZE,
    height: REMOVE_BUTTON_SIZE,
    borderRadius: 9999,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const removeTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.bodyBold,
    lineHeight: REMOVE_BUTTON_SIZE,
    textAlign: 'center',
  };

  const progressOverlayStyle: ViewStyle = {
    ...thumbnailWrapperStyle,
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const progressTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontSize: theme.typography.fontSize.xs,
    fontFamily: theme.typography.fontFamily.mono,
  };

  const videoTileStyle: ViewStyle = {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const videoDurationStyle: TextStyle = {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.xs,
    fontFamily: theme.typography.fontFamily.mono,
    marginTop: 4,
  };

  const videoLabelStyle: TextStyle = {
    color: theme.colors.textTertiary,
    fontSize: theme.typography.fontSize.xs,
    fontFamily: theme.typography.fontFamily.body,
  };

  return (
    <View style={containerStyle} testID="media-thumbnail-strip">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
      >
        {media.map((item, index) => {
          const progress = uploadProgress?.[index];
          const isUploading = progress != null && progress < 1;
          const isVideo = item.type.startsWith('video/');

          return (
            <View key={item.uri} style={thumbnailWrapperStyle}>
              {isVideo ? (
                <View style={videoTileStyle}>
                  {/* Raw glyph, not PlayIconOverlay: the strip tile stacks
                      glyph + duration in flow layout; the overlay primitive
                      is absolute-centered and would cover the duration. */}
                  <Text style={videoLabelStyle}>{'▶'}</Text>
                  {item.duration != null && (
                    <Text style={videoDurationStyle}>
                      {formatDurationSeconds(item.duration)}
                    </Text>
                  )}
                </View>
              ) : (
                <Image
                  source={{ uri: item.uri }}
                  style={imageStyle}
                  accessibilityLabel={`Selected media ${index + 1}`}
                />
              )}
              {isUploading && (
                <View style={progressOverlayStyle}>
                  <Text style={progressTextStyle}>
                    {Math.round(progress * 100)}%
                  </Text>
                </View>
              )}
              {!isUploading && (
                <TouchableOpacity
                  style={removeButtonStyle}
                  onPress={() => onRemove(index)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove media ${index + 1}`}
                  testID={`remove-media-${index}`}
                >
                  <Text style={removeTextStyle}>X</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
