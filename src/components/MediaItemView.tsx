/**
 * MediaItemView — Single media item renderer.
 *
 * Handles all download states: no keys (encrypted placeholder), pending
 * (auto-download triggered), downloading (spinner), failed (tap to retry),
 * and downloaded (displays the image).
 *
 * Uses the useMediaDownload hook internally to auto-trigger downloads
 * and provide retry functionality.
 */

import React, { useCallback, useRef } from 'react';
import {
  Image,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { useMediaDownload } from '../hooks/useMediaDownload';
import { useAppStore } from '../stores/useAppStore';
import { OrbitalSpinner } from './OrbitalSpinner';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaItemViewProps {
  mediaId: string;
  width: number;
  height: number;
  onPress?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MediaItemView = React.memo(function MediaItemView({
  mediaId,
  width,
  height,
  onPress,
}: MediaItemViewProps): React.JSX.Element {
  const theme = useTheme();
  const { downloadState, localPath, hasKeys, retry } = useMediaDownload(mediaId);

  const imageErrorCount = useRef(0);
  const handleImageError = useCallback(() => {
    imageErrorCount.current += 1;
    if (imageErrorCount.current > 1) {
      // Repeated error — file is corrupt, not just missing. Set failed to stop the loop.
      useAppStore.getState().updateMediaDownloadState(mediaId, 'failed');
      return;
    }
    const existing = useAppStore.getState().media[mediaId];
    if (existing) {
      useAppStore.getState().upsertMedia({
        ...existing,
        downloadState: 'pending',
        localPath: null,
      });
    }
  }, [mediaId]);

  const placeholderStyle: ViewStyle = {
    width,
    height,
    backgroundColor: theme.colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const placeholderTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.xs,
  };

  const lockTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.textTertiary,
  };

  // No keys — show encrypted placeholder
  if (!hasKeys) {
    return (
      <View style={placeholderStyle} testID={`media-item-${mediaId}-locked`}>
        <Text style={lockTextStyle}>{'[locked]'}</Text>
        <Text style={placeholderTextStyle}>Encrypted</Text>
      </View>
    );
  }

  // Pending — placeholder while auto-download triggers
  if (downloadState === 'pending') {
    return (
      <View style={placeholderStyle} testID={`media-item-${mediaId}-pending`} />
    );
  }

  // Downloading — placeholder with spinner
  if (downloadState === 'downloading') {
    return (
      <View style={placeholderStyle} testID={`media-item-${mediaId}-downloading`}>
        <OrbitalSpinner size={24} />
      </View>
    );
  }

  // Failed — tap to retry
  if (downloadState === 'failed') {
    return (
      <TouchableOpacity
        style={placeholderStyle}
        onPress={retry}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Tap to retry download"
        testID={`media-item-${mediaId}-failed`}
      >
        <Text style={placeholderTextStyle}>Tap to retry</Text>
      </TouchableOpacity>
    );
  }

  // Downloaded — show the image
  if (localPath) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        disabled={!onPress}
        accessibilityRole="image"
        accessibilityLabel="Photo"
        testID={`media-item-${mediaId}-loaded`}
      >
        <Image
          source={{ uri: `file://${localPath}` }}
          style={{ width, height }}
          resizeMode="cover"
          onError={handleImageError}
        />
      </TouchableOpacity>
    );
  }

  // Fallback — downloaded but no local path (file was cleaned up or cache cleared)
  return (
    <TouchableOpacity
      style={placeholderStyle}
      onPress={retry}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Tap to retry download"
      testID={`media-item-${mediaId}-recovery`}
    >
      <Text style={placeholderTextStyle}>Tap to retry</Text>
    </TouchableOpacity>
  );
});
