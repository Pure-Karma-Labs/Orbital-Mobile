/**
 * MediaItemView — Single media item renderer.
 *
 * Handles all download states: no keys (encrypted placeholder), pending
 * (auto-download triggered), downloading (spinner), failed (tap to retry),
 * and downloaded (displays the image).
 *
 * Video items render a decoded thumbnail with a centered play icon overlay
 * and a duration badge. The full video is NEVER auto-downloaded here —
 * thumbnail is the display payload; PR 3's player owns full download.
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
import { useVideoThumbnail } from '../hooks/useVideoThumbnail';
import { useAppStore } from '../stores/useAppStore';
import { OrbitalSpinner } from './OrbitalSpinner';
import { PlayIconOverlay, DurationBadge } from './VideoOverlay';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaItemViewProps {
  mediaId: string;
  width: number;
  height: number;
  onPress?: () => void;
  /** MIME content type — required for video detection. */
  contentType?: string;
  /** Video duration in milliseconds. Null/undefined omits the badge. */
  durationMs?: number | null;
  /** Media ID of the thumbnail child row (for video parent items). */
  thumbnailMediaId?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MediaItemView = React.memo(function MediaItemView({
  mediaId,
  width,
  height,
  onPress,
  contentType,
  durationMs,
  thumbnailMediaId,
}: MediaItemViewProps): React.JSX.Element {
  const theme = useTheme();

  // --- Video thumbnail hook (always called unconditionally) ----------------
  const {
    isVideo,
    thumbState,
    thumbLocalPath,
  } = useVideoThumbnail(contentType, thumbnailMediaId);

  // --- Image download hook -------------------------------------------------
  // SUPPRESSION: for video items, pass null to prevent auto-downloading the
  // full video file — the thumbnail child is the display payload.
  const { downloadState, localPath, hasKeys, retry } = useMediaDownload(
    isVideo ? null : mediaId,
  );

  // --- Image onError (2-strike) for images ---------------------------------
  const imageErrorCount = useRef(0);
  const handleImageError = useCallback(() => {
    imageErrorCount.current += 1;
    if (imageErrorCount.current > 1) {
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

  // --- Thumbnail onError (2-strike) for video thumbnails -------------------
  // Keys on the THUMBNAIL child id, not the parent video id.
  const thumbErrorCount = useRef(0);
  const handleThumbError = useCallback(() => {
    if (!thumbnailMediaId) return;
    thumbErrorCount.current += 1;
    if (thumbErrorCount.current > 1) {
      useAppStore.getState().updateMediaDownloadState(thumbnailMediaId, 'failed');
      return;
    }
    const existing = useAppStore.getState().media[thumbnailMediaId];
    if (existing) {
      useAppStore.getState().upsertMedia({
        ...existing,
        downloadState: 'pending',
        localPath: null,
      });
    }
  }, [thumbnailMediaId]);

  // ---------------------------------------------------------------------------
  // Shared styles
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // VIDEO branch — must short-circuit BEFORE the !hasKeys early return below,
  // because useMediaDownload(null) yields hasKeys:false for video items.
  // ---------------------------------------------------------------------------

  if (isVideo) {
    const hasDuration = durationMs != null;

    // Video: thumb downloaded + path
    if (thumbState === 'downloaded' && thumbLocalPath) {
      return (
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.85}
          disabled={!onPress}
          accessibilityRole="image"
          accessibilityLabel="Video"
          testID={`media-item-${mediaId}-video-loaded`}
        >
          <Image
            source={{ uri: `file://${thumbLocalPath}` }}
            style={{ width, height }}
            resizeMode="cover"
            onError={handleThumbError}
          />
          <PlayIconOverlay />
          {hasDuration && <DurationBadge durationMs={durationMs} />}
        </TouchableOpacity>
      );
    }

    // Video: downloading thumbnail
    if (thumbState === 'downloading') {
      return (
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.85}
          disabled={!onPress}
          accessibilityRole="image"
          accessibilityLabel="Video"
          testID={`media-item-${mediaId}-video-downloading`}
          style={placeholderStyle}
        >
          <OrbitalSpinner size={24} />
          <PlayIconOverlay />
          {hasDuration && <DurationBadge durationMs={durationMs} />}
        </TouchableOpacity>
      );
    }

    // Video: pending (auto-download triggering)
    if (thumbState === 'pending') {
      return (
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.85}
          disabled={!onPress}
          accessibilityRole="image"
          accessibilityLabel="Video"
          testID={`media-item-${mediaId}-video-pending`}
          style={placeholderStyle}
        >
          <PlayIconOverlay />
          {hasDuration && <DurationBadge durationMs={durationMs} />}
        </TouchableOpacity>
      );
    }

    // Video: failed OR 'unavailable' (null thumbnailMediaId, no keys, DB miss)
    // Dark tile with play icon + badge. ZERO <Image> nodes. NEVER <Image> the video file.
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        disabled={!onPress}
        accessibilityRole="image"
        accessibilityLabel="Video"
        testID={`media-item-${mediaId}-video-fallback`}
        style={{
          width,
          height,
          backgroundColor: theme.colors.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlayIconOverlay />
        {hasDuration && <DurationBadge durationMs={durationMs} />}
      </TouchableOpacity>
    );
  }

  // ---------------------------------------------------------------------------
  // IMAGE branch — existing logic, byte-for-byte
  // ---------------------------------------------------------------------------

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
