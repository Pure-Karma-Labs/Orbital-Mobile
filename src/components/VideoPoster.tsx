/**
 * VideoPoster — static poster surface for a lightbox video page.
 *
 * Renders the decoded thumbnail child (never the video file itself) with an
 * optional play affordance, a duration badge, and an optional centred overlay
 * slot for download progress chrome.
 *
 * Deliberately does NOT take a full-video download hook: mounting a poster
 * must never start a ~30-50MB transfer. Only `ActiveVideoPage` downloads the
 * video, and only while its page is the active one.
 *
 * The thumbnail child IS downloaded here (via useVideoThumbnail), exactly as
 * MediaItemView does — it is a small image and the display payload.
 */

import React, { useCallback, useRef } from 'react';
import { Image, View, type ViewStyle } from 'react-native';
import { useVideoThumbnail } from '../hooks/useVideoThumbnail';
import { PlayIconOverlay, DurationBadge } from './VideoOverlay';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VideoPosterProps {
  mediaId: string;
  pageWidth: number;
  pageHeight: number;
  /** MIME content type — drives useVideoThumbnail's isVideo gate. */
  contentType?: string;
  /** Media ID of the thumbnail child row. */
  thumbnailMediaId?: string | null;
  /** Video duration in milliseconds. Null/undefined omits the badge. */
  durationMs?: number | null;
  /**
   * Show the centred play glyph. Suppressed while the full video is
   * downloading (a spinner is the affordance then) and once the native
   * player owns the transport.
   */
  showPlayIcon?: boolean;
  /** Centred overlay content rendered above the thumbnail (spinner, labels). */
  children?: React.ReactNode;
  testID?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const VideoPoster = React.memo(function VideoPoster({
  mediaId,
  pageWidth,
  pageHeight,
  contentType,
  thumbnailMediaId,
  durationMs,
  showPlayIcon = true,
  children,
  testID,
}: VideoPosterProps): React.JSX.Element {
  const { thumbState, thumbLocalPath, retryThumb } = useVideoThumbnail(
    contentType,
    thumbnailMediaId,
  );

  // One recovery attempt if the thumbnail file is corrupt/evicted; a second
  // error gives up (play overlay + badge remain visible as siblings).
  const thumbErrorRetried = useRef(false);
  const handleThumbImageError = useCallback(() => {
    if (!thumbErrorRetried.current) {
      thumbErrorRetried.current = true;
      retryThumb();
    }
  }, [retryThumb]);

  const containerStyle: ViewStyle = {
    width: pageWidth,
    height: pageHeight,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const hasThumb = thumbState === 'downloaded' && thumbLocalPath != null;

  return (
    <View
      style={containerStyle}
      testID={testID ?? `lightbox-video-poster-${mediaId}`}
    >
      {hasThumb && (
        <Image
          source={{ uri: `file://${thumbLocalPath}` }}
          style={{ width: pageWidth, height: pageHeight }}
          resizeMode="contain"
          onError={handleThumbImageError}
        />
      )}
      {showPlayIcon && <PlayIconOverlay size={64} />}
      {children}
      {durationMs != null && <DurationBadge durationMs={durationMs} />}
    </View>
  );
});
