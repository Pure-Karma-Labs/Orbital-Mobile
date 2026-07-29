/**
 * ActiveVideoPage — the ONLY file allowed to import react-native-video.
 *
 * Mounted exclusively for the lightbox page the user is actually looking at
 * (`isActive` in LightboxVideoPage). That conditional mount is load-bearing in
 * two directions:
 *
 *  - Mounting starts the full-video download (~30-50MB) with the REAL media id.
 *  - Unmounting (swipe away, or the Modal's `visible` flipping false) is a real
 *    React unmount, so useMediaDownload's `cancelOnUnmount` cleanup actually
 *    runs and aborts a still-queued transfer. A mediaId-swap gate would NOT
 *    cancel: the hook sets downloadingRef synchronously before acquiring the
 *    semaphore, so its own effect cleanup skips the abort and drops the only
 *    cancel handle.
 *
 * Unmount-on-inactive is also the pause: there is no seek-position memory by
 * design — swiping back restarts at 0:00.
 *
 * PROPS ONLY, NEVER THE REF API: react-native-video 6.x ships no Fabric
 * component (`requireNativeComponent('RCTVideo')`), so it renders through RN's
 * legacy ViewManager interop layer where imperative ref calls silently no-op.
 */

import React, { useCallback, useState } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Video, {
  type OnLoadData,
  type OnPlaybackStateChangedData,
  type OnVideoErrorData,
} from 'react-native-video';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import { useMediaDownload } from '../hooks/useMediaDownload';
import { formatMB } from '../utils/formatBytes';
import { OrbitalSpinner } from './OrbitalSpinner';
import { VideoPoster } from './VideoPoster';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ActiveVideoPageProps {
  mediaId: string;
  pageWidth: number;
  pageHeight: number;
  contentType?: string;
  thumbnailMediaId?: string | null;
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActiveVideoPage({
  mediaId,
  pageWidth,
  pageHeight,
  contentType,
  thumbnailMediaId,
  durationMs,
}: ActiveVideoPageProps): React.JSX.Element {
  const theme = useTheme();

  // Primitive selectors only — returning a derived object here would be a new
  // reference on every store write and re-render the player forever.
  const itemExists = useAppStore((state) => state.media[mediaId] !== undefined);
  const fileSize = useAppStore((state) => state.media[mediaId]?.fileSize ?? null);

  // Real id, unconditionally: this component's existence IS the decision to
  // download. cancelOnUnmount must be static for the instance lifetime.
  const { downloadState, localPath, hasKeys, retry } = useMediaDownload(mediaId, {
    cancelOnUnmount: true,
  });

  // Native player state. `paused` starts true — no autoplay, ever.
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);

  const handleReadyForDisplay = useCallback(() => setReady(true), []);
  const handleLoad = useCallback((_e: OnLoadData) => setReady(true), []);
  const handlePlaybackStateChanged = useCallback(
    (e: OnPlaybackStateChangedData) => setPaused(!e.isPlaying),
    [],
  );

  /**
   * Terminal on the FIRST error — no retry.
   *
   * A player error means the local plaintext file is unplayable, and the
   * download-retry path cannot fix that: retryDownload() flips state to
   * 'pending' WITHOUT clearing local_path, so downloadAndDecryptMedia's cache
   * check returns the existing file early and never restores 'downloaded' —
   * a permanent spinner. Invalidating the local copy needs a nullable
   * local_path repo variant (DEBT-186), out of scope here.
   */
  const handleError = useCallback((e: OnVideoErrorData) => {
    if (__DEV__) {
      console.warn('[ActiveVideoPage] player error', JSON.stringify(e?.error ?? {}));
    }
    setPlayerFailed(true);
  }, []);

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  const pageStyle: ViewStyle = {
    width: pageWidth,
    height: pageHeight,
    alignItems: 'center',
    justifyContent: 'center',
  };

  // Lightbox chrome is light-on-dark; MediaItemView's tile styling would be
  // invisible here. Copy is reused verbatim, colours are the lightbox's.
  const hintTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: theme.spacing.base,
    textAlign: 'center',
  };

  const lockTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.lg,
    color: 'rgba(255, 255, 255, 0.7)',
  };

  const captionTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: theme.spacing.xs,
  };

  // -------------------------------------------------------------------------
  // 1. Player error — terminal, poster overlay removed, Report stays in chrome
  // -------------------------------------------------------------------------
  if (playerFailed) {
    return (
      <View style={pageStyle} testID={`lightbox-video-error-${mediaId}`}>
        <Text style={hintTextStyle}>{"Couldn't play this video"}</Text>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 2. Store miss — NOT keyless. The item simply hasn't hydrated yet.
  // -------------------------------------------------------------------------
  if (!itemExists) {
    return (
      <View style={pageStyle} testID={`lightbox-video-pending-${mediaId}`}>
        <OrbitalSpinner size={32} />
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 3. No attachment keys — reuse MediaItemView's keyless copy. No spinner.
  // -------------------------------------------------------------------------
  if (!hasKeys) {
    return (
      <View style={pageStyle} testID={`lightbox-video-locked-${mediaId}`}>
        <Text style={lockTextStyle}>{'[locked]'}</Text>
        <Text style={captionTextStyle}>Encrypted</Text>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 4. Unavailable — server purged and no local copy (D10: local file wins)
  // -------------------------------------------------------------------------
  if (downloadState === 'unavailable' && !localPath) {
    return (
      <View style={pageStyle} testID={`lightbox-video-unavailable-${mediaId}`}>
        <Text style={hintTextStyle}>{'No longer available'}</Text>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 5. Download failed — retry is sound here (no local file exists yet)
  // -------------------------------------------------------------------------
  if (downloadState === 'failed') {
    return (
      <TouchableOpacity
        style={pageStyle}
        onPress={retry}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Tap to retry download"
        testID={`lightbox-video-failed-${mediaId}`}
      >
        <Text style={hintTextStyle}>Tap to retry</Text>
      </TouchableOpacity>
    );
  }

  // -------------------------------------------------------------------------
  // 6. Downloaded — mount the native player
  // -------------------------------------------------------------------------
  if (downloadState === 'downloaded' && localPath) {
    return (
      <View style={pageStyle}>
        <Video
          testID={`lightbox-video-${mediaId}`}
          // The mp4/mov/m4v extension is load-bearing on iOS: AVFoundation
          // infers the container from it (PR #644).
          source={{ uri: `file://${localPath}` }}
          style={{ width: pageWidth, height: pageHeight }}
          resizeMode="contain"
          controls
          paused={paused}
          // Content-escape surface pinned off — decrypted family video must not
          // reach AirPlay/external displays, the lock screen, or background audio.
          allowsExternalPlayback={false}
          playInBackground={false}
          playWhenInactive={false}
          showNotificationControls={false}
          // Tapping play is an explicit intent to hear it.
          ignoreSilentSwitch="ignore"
          mixWithOthers="duck"
          // Android honours this; iOS's native fullscreen button is not
          // suppressible via props (open smoke item).
          controlsStyles={{ hideFullscreen: true }}
          onLoad={handleLoad}
          onReadyForDisplay={handleReadyForDisplay}
          onPlaybackStateChanged={handlePlaybackStateChanged}
          onError={handleError}
        />
        {!ready && (
          <View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            pointerEvents="none"
            testID={`lightbox-video-poster-overlay-${mediaId}`}
          >
            <VideoPoster
              mediaId={mediaId}
              pageWidth={pageWidth}
              pageHeight={pageHeight}
              contentType={contentType}
              thumbnailMediaId={thumbnailMediaId}
              durationMs={durationMs}
              showPlayIcon={false}
            />
          </View>
        )}
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 7. pending / downloading — poster + spinner + static size label
  //    (no progress ring until #578 exposes byte progress)
  // -------------------------------------------------------------------------
  return (
    <VideoPoster
      mediaId={mediaId}
      pageWidth={pageWidth}
      pageHeight={pageHeight}
      contentType={contentType}
      thumbnailMediaId={thumbnailMediaId}
      durationMs={durationMs}
      showPlayIcon={false}
      testID={`lightbox-video-downloading-${mediaId}`}
    >
      <OrbitalSpinner size={32} />
      {fileSize != null && fileSize > 0 && (
        <Text style={hintTextStyle} testID={`lightbox-video-size-${mediaId}`}>
          {`Downloading · ${formatMB(fileSize)}`}
        </Text>
      )}
    </VideoPoster>
  );
}
