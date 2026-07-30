/**
 * LightboxVideoPage — the video branch of a MediaLightbox page.
 *
 * Structure (deliberate, see ActiveVideoPage's header):
 *
 *   LightboxVideoPage
 *   └─ isActive ? <ActiveVideoPage/>   (downloads + plays)
 *               : <VideoPoster/>       (thumbnail only, never downloads)
 *
 * `isActive` is `visible && index === currentIndex`, computed by MediaLightbox.
 * The `visible &&` term matters on iOS: Modal keeps its children mounted until
 * the dismiss animation completes (onDismiss), so without it a closed lightbox
 * would keep a player alive and audible.
 *
 * Swapping between the two branches is a real mount/unmount, which is what
 * makes useMediaDownload's cancelOnUnmount abort a queued transfer.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';
import type { GestureType } from 'react-native-gesture-handler';
import { ActiveVideoPage } from './ActiveVideoPage';
import { VideoPoster } from './VideoPoster';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LightboxVideoPageProps {
  mediaId: string;
  pageWidth: number;
  pageHeight: number;
  contentType?: string;
  thumbnailMediaId?: string | null;
  durationMs?: number | null;
  /** visible && index === currentIndex — see module header. */
  isActive: boolean;
  /**
   * Pass-through only: MediaLightbox -> ActiveVideoPage -> VideoControls.
   * See VideoControlsProps.scrollGesture (A4 tier (iii), unwired today).
   */
  scrollGesture?: GestureType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LightboxVideoPage = React.memo(function LightboxVideoPage({
  mediaId,
  pageWidth,
  pageHeight,
  contentType,
  thumbnailMediaId,
  durationMs,
  isActive,
  scrollGesture,
}: LightboxVideoPageProps): React.JSX.Element {
  const pageStyle: ViewStyle = {
    width: pageWidth,
    height: pageHeight,
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <View testID={`lightbox-page-${mediaId}`} style={pageStyle}>
      {isActive ? (
        <ActiveVideoPage
          mediaId={mediaId}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          contentType={contentType}
          thumbnailMediaId={thumbnailMediaId}
          durationMs={durationMs}
          scrollGesture={scrollGesture}
        />
      ) : (
        <VideoPoster
          mediaId={mediaId}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          contentType={contentType}
          thumbnailMediaId={thumbnailMediaId}
          durationMs={durationMs}
        />
      )}
    </View>
  );
});
