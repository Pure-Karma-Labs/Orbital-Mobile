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
 * AUTOPLAY: mounting an active page starts playback (`paused` initialises
 * false). Opening the lightbox on a video, or swiping onto one, IS the play
 * intent — #662 replaced the old three-taps-to-play flow.
 *
 * AUDIO POLICY (Alex, 2026-07-30, deliberate): full sound on autoplay.
 * `ignoreSilentSwitch="ignore"` is retained, so a silenced iPhone still plays
 * audio, and on Android the exclusive AUDIOFOCUS_GAIN request stops whatever
 * music was playing (`mixWithOthers="duck"` is iOS-only; Android cannot duck).
 * Both consequences are accepted: tapping a video thumbnail means you want to
 * watch it with sound, and the volume rocker is the mute control.
 *
 * PROPS ONLY, WITH ONE DOCUMENTED EXCEPTION: react-native-video 6.x ships no
 * Fabric component (`requireNativeComponent('RCTVideo')`), so it renders
 * through RN's legacy ViewManager interop layer where Fabric ref methods
 * silently no-op. `seek()` is NOT one of them — src/Video.tsx:390-416 shows it
 * is a plain JS closure over the legacy bridge NativeModule
 * `VideoManager.seekCmd` (iOS unwraps the interop wrapper via RCTBridgeProxy;
 * Android dispatches through UIManagerHelper with UIManagerType.FABRIC, gated
 * on the app's `newArchEnabled` gradle property — enforced by the
 * `rnv-newarch-required` security invariant). Scrubbing therefore uses the ref;
 * play/pause stays on the controlled `paused` prop.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  NativeModules,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Video, {
  type OnLoadData,
  type OnPlaybackStateChangedData,
  type OnProgressData,
  type OnVideoErrorData,
  type VideoRef,
} from 'react-native-video';
import type { GestureType } from 'react-native-gesture-handler';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import { useMediaDownload } from '../hooks/useMediaDownload';
import { formatMB } from '../utils/formatBytes';
import { OrbitalSpinner } from './OrbitalSpinner';
import { VideoPoster } from './VideoPoster';
import { VideoControls } from './videoControls/VideoControls';
import { useControlsVisibility } from './videoControls/useControlsVisibility';
import { clampSeconds, PROGRESS_INTERVAL_MS } from './videoControls/scrubberLogic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Focus-denial watchdog window. If play intent is set and no onProgress lands
 * within this, the player is not actually running — the usual cause is Android
 * refusing the audio-focus request (`requestAudioFocus()` gates
 * `setPlayWhenReady`, ReactExoplayerView.java:1326-1339). Force `paused` back
 * on so the overlay never shows a pause glyph over a dead player.
 *
 * Exported for the tests that drive it with fake timers.
 */
export const PLAY_INTENT_TIMEOUT_MS = 1000;

/**
 * Grace period before a native `isPlaying: false` that carries NO user intent
 * is mirrored into the controlled `paused` prop.
 *
 * With autoplay plus Android's exclusive audio focus, a notification sound is
 * enough to make ExoPlayer emit a transient isPlaying=false. Mirroring that
 * immediately round-trips to setPlayWhenReady(false), which is a LATCH:
 * ExoPlayer restores playWhenReady itself when focus returns, but it cannot
 * override a controlled prop, so the video would stay dead for good. Waiting
 * out the dip lets the self-resume happen; a genuine external pause (headphone
 * unplug, another app taking focus for real) still lands, just this much later.
 *
 * Exported for the tests that drive it with fake timers.
 */
export const TRANSIENT_PAUSE_GRACE_MS = 2000;

/** __DEV__ only, once per app run — see the ref-API note in the header. */
let videoManagerAsserted = false;

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
  /**
   * Pre-designed A4 tier (iii) escape hatch, forwarded verbatim to
   * VideoControls — see VideoControlsProps.scrollGesture. Undefined today.
   */
  scrollGesture?: GestureType;
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
  scrollGesture,
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

  // Native player state. `paused` starts FALSE — mounting an active page is
  // the play intent (#662 autoplay; see the header's audio-policy note).
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);

  // Overlay-controls state.
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** True between onEnd and the next play/seek — the next play replays from 0. */
  const [ended, setEnded] = useState(false);

  // `ready &&` matters: the overlay only mounts once the first frame is up, so
  // the 3s countdown must not run down during a slow download/load.
  const { visible: controlsVisible, notify: notifyControls } =
    useControlsVisibility(ready && !paused);

  const videoRef = useRef<VideoRef>(null);
  /** Flipped by onProgress; read by the focus-denial watchdog. */
  const progressSinceIntentRef = useRef(false);
  /**
   * True when the user (or onEnd) asked for the pause currently in effect.
   * Distinguishes intentional stops from transient audio-focus dips — see
   * TRANSIENT_PAUSE_GRACE_MS.
   */
  const userPausedRef = useRef(false);
  const transientPauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransientPauseTimer = useCallback(() => {
    if (transientPauseTimerRef.current !== null) {
      clearTimeout(transientPauseTimerRef.current);
      transientPauseTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTransientPauseTimer, [clearTransientPauseTimer]);

  useEffect(() => {
    if (!__DEV__ || videoManagerAsserted) return;
    videoManagerAsserted = true;
    if (NativeModules.VideoManager == null) {
      // console.warn, not error: Jest --ci fails a test on console.error.
      console.warn(
        '[ActiveVideoPage] NativeModules.VideoManager is missing — seek() is a no-op. ' +
          'Check newArchEnabled / the react-native-video native build.',
      );
    }
  }, []);

  const handleReadyForDisplay = useCallback(() => setReady(true), []);

  const handleLoad = useCallback((e: OnLoadData) => {
    setReady(true);
    if (Number.isFinite(e?.duration) && e.duration > 0) {
      setDuration(e.duration);
    }
  }, []);

  /**
   * Scrubber position comes from onProgress, NEVER from onSeek: Android does
   * not reliably emit onSeek while paused, so a seek-driven bar would freeze.
   */
  const handleProgress = useCallback((e: OnProgressData) => {
    progressSinceIntentRef.current = true;
    if (Number.isFinite(e?.currentTime)) {
      setCurrentTime(e.currentTime);
    }
    // onLoad occasionally lands with duration 0 on Android; onProgress carries
    // seekableDuration and is the reliable late source.
    if (Number.isFinite(e?.seekableDuration) && e.seekableDuration > 0) {
      setDuration((prev) => (prev > 0 ? prev : e.seekableDuration));
    }
  }, []);

  /**
   * Mirrors native transport state into the controlled `paused` prop — with
   * two guards, because this prop is a latch the player cannot override.
   *
   *  - `isSeeking`: media3 drops isPlaying during the STATE_BUFFERING pass that
   *    every scrubber seek triggers. A seek transition is not pause intent.
   *    (iOS never emits the dip.)
   *  - No user intent + isPlaying false: treated as POSSIBLY transient (audio
   *    focus stolen by a notification sound). Deferred by
   *    TRANSIENT_PAUSE_GRACE_MS; an isPlaying=true inside the window cancels
   *    it, so ExoPlayer's own resume-on-focus-regain survives.
   *
   * Resumes are mirrored immediately, and a pause the user asked for latches
   * with no delay.
   */
  const handlePlaybackStateChanged = useCallback(
    (e: OnPlaybackStateChangedData) => {
      if (e.isSeeking) {
        return;
      }

      if (e.isPlaying) {
        clearTransientPauseTimer();
        setPaused(false);
        return;
      }

      if (userPausedRef.current) {
        clearTransientPauseTimer();
        setPaused(true);
        return;
      }

      // Already waiting out a dip — do not restart the clock.
      if (transientPauseTimerRef.current !== null) {
        return;
      }
      transientPauseTimerRef.current = setTimeout(() => {
        transientPauseTimerRef.current = null;
        setPaused(true);
      }, TRANSIENT_PAUSE_GRACE_MS);
    },
    [clearTransientPauseTimer],
  );

  const handleEnd = useCallback(() => {
    // Reaching the end IS intent to stop — latch immediately, no grace period.
    userPausedRef.current = true;
    clearTransientPauseTimer();
    setPaused(true);
    setEnded(true);
    // Force the chrome back up so the replay affordance is reachable.
    notifyControls('ended');
  }, [notifyControls, clearTransientPauseTimer]);

  const handleTogglePlay = useCallback(() => {
    if (paused) {
      if (ended) {
        // Replay: rewind first, then release the transport.
        videoRef.current?.seek(0);
        setCurrentTime(0);
        setEnded(false);
      }
      userPausedRef.current = false;
      clearTransientPauseTimer();
      setPaused(false);
      notifyControls('play');
    } else {
      userPausedRef.current = true;
      clearTransientPauseTimer();
      setPaused(true);
      notifyControls('pause');
    }
  }, [paused, ended, notifyControls, clearTransientPauseTimer]);

  const handleSeek = useCallback(
    (seconds: number) => {
      const target = clampSeconds(seconds, duration);
      videoRef.current?.seek(target);
      // Optimistic: the bar must not snap backwards while the player buffers.
      setCurrentTime(target);
      if (duration > 0 && target < duration) {
        setEnded(false);
      }
    },
    [duration],
  );

  /**
   * Focus-denial watchdog (spike A2 acceptance criterion). Armed on every
   * transition into play intent; disarmed the moment `paused` flips back.
   *
   * `ready` gates it: before onLoad there is no player to make progress (the
   * file may still be downloading), and arming then would pause the autoplay
   * we are about to start.
   */
  useEffect(() => {
    if (paused || !ready) return;
    progressSinceIntentRef.current = false;
    const timer = setTimeout(() => {
      if (progressSinceIntentRef.current) return;
      if (__DEV__) {
        console.warn(
          '[ActiveVideoPage] no playback progress within 1s of play intent — ' +
            'forcing pause (audio focus denied?)',
        );
      }
      setPaused(true);
    }, PLAY_INTENT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [paused, ready]);

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
          ref={videoRef}
          testID={`lightbox-video-${mediaId}`}
          // The mp4/mov/m4v extension is load-bearing on iOS: AVFoundation
          // infers the container from it (PR #644).
          source={{ uri: `file://${localPath}` }}
          style={{ width: pageWidth, height: pageHeight }}
          // Explicit: iOS defaults to cover.
          resizeMode="contain"
          paused={paused}
          // Content-escape surface pinned off — decrypted family video must not
          // reach AirPlay/external displays, the lock screen, background audio,
          // or a floating PiP window that outlives this lightbox. Enforced by
          // the `rnv-content-escape-pins` invariant, which reads the props of
          // this element specifically.
          allowsExternalPlayback={false}
          playInBackground={false}
          playWhenInactive={false}
          showNotificationControls={false}
          enterPictureInPictureOnLeave={false}
          // Native chrome OFF — replaced by the VideoControls sibling below.
          // It never received touches through the Android interop seam, and its
          // show/hide requestLayout storm drove the portrait/landscape collapse
          // (#663). Pinned explicitly rather than left to default so the
          // invariant can enforce it.
          controls={false}
          // Deliberate audio policy — see the module header.
          ignoreSilentSwitch="ignore"
          mixWithOthers="duck"
          progressUpdateInterval={PROGRESS_INTERVAL_MS}
          onLoad={handleLoad}
          onProgress={handleProgress}
          onEnd={handleEnd}
          onReadyForDisplay={handleReadyForDisplay}
          onPlaybackStateChanged={handlePlaybackStateChanged}
          onError={handleError}
        />
        {ready && (
          <VideoControls
            paused={paused}
            currentTime={currentTime}
            duration={duration}
            visible={controlsVisible}
            onTogglePlay={handleTogglePlay}
            onSeek={handleSeek}
            onInteraction={notifyControls}
            scrollGesture={scrollGesture}
          />
        )}
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
