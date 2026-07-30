/**
 * VideoControls — the custom JS overlay that replaced react-native-video's
 * native `controls` chrome (#662, partially #663).
 *
 * Why custom at all: on Android the media3 controller sits behind RN 0.82's
 * legacy ViewManager interop seam and never receives touches, and its show/hide
 * requestLayout storm is what latched the portrait->landscape collapse. On iOS
 * it worked but shipped a second ✕ button and cost three taps to start a video.
 * `controls={false}` deletes both problems at the root.
 *
 * STRUCTURAL REQUIREMENT: this renders as an absolutely-positioned SIBLING of
 * <Video>, never a child. iOS RCTVideo RCTLogErrors on any subview
 * (RCTVideo.swift:1385-1392).
 *
 * This component is deliberately dumb — every prop is supplied by
 * ActiveVideoPage, which owns the player. All maths and the visibility state
 * machine live in scrubberLogic.ts (see its header for why).
 *
 * Colour note: lightbox chrome is light-on-dark, so it uses literal
 * rgba()/#FFFFFF rather than theme palette entries — the same
 * deliberately-not-theme-palette convention as ActiveVideoPage's hint text and
 * MediaLightbox's buttons.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { formatDurationSeconds } from '../../utils/formatDuration';
import {
  fractionOfDuration,
  offsetToSeconds,
  type VisibilityEvent,
} from './scrubberLogic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Transport glyphs.
 *
 * PLAY carries U+FE0E VARIATION SELECTOR-15. U+25B6 BLACK RIGHT-POINTING
 * TRIANGLE is emoji-eligible, and iOS defaults it to emoji presentation — it
 * rendered as a grey rounded emoji button on device while Android showed the
 * plain text triangle. VS-15 forces text presentation on both.
 *
 * PAUSE (U+275A HEAVY VERTICAL BAR) is text-default everywhere and needs no
 * selector. Add VS-15 to any new glyph that appears in Unicode's emoji data.
 */
const PLAY_GLYPH = '▶︎';
const PAUSE_GLYPH = '❚❚';

const TOGGLE_BUTTON_SIZE = 64;
/**
 * How long a control interaction suppresses the full-page tap toggle.
 *
 * Exported for the tests that drive the boundary with a mocked clock.
 */
export const CONTROL_SUPPRESSION_MS = 400;
const TRACK_HEIGHT = 3;
const TRACK_HIT_HEIGHT = 28;
const THUMB_SIZE = 12;
const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VideoControlsProps {
  /** Transport state, owned upstream by the `paused` prop on <Video>. */
  paused: boolean;
  /** Latest onProgress currentTime, in seconds. */
  currentTime: number;
  /** onLoad duration, in seconds. 0 until the player reports it. */
  duration: number;
  /** Chrome shown/hidden — from useControlsVisibility. */
  visible: boolean;
  onTogglePlay: () => void;
  /** Fired ONCE per drag, on release, with the committed position in seconds. */
  onSeek: (seconds: number) => void;
  /** Feeds the visibility state machine. */
  onInteraction: (event: VisibilityEvent) => void;
  /**
   * Pre-designed A4 tier (iii) escape hatch — the paging ScrollView wrapped in
   * `Gesture.Native()`. When supplied, the scrubber pan declares
   * `.blocksExternalGesture(scrollGesture)` so RNGH stops the ScrollView from
   * winning the horizontal drag. MediaLightbox does not produce one today
   * (tier (i), plain RNGH arbitration, is what shipped); the prop is threaded
   * from day one because retrofitting the chain through three components later
   * is the expensive part, not the one line below.
   */
  scrollGesture?: GestureType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoControls({
  paused,
  currentTime,
  duration,
  visible,
  onTogglePlay,
  onSeek,
  onInteraction,
  scrollGesture,
}: VideoControlsProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [trackWidth, setTrackWidth] = useState(0);
  /** Non-null only while a drag is in flight — the bar renders this instead. */
  const [previewSeconds, setPreviewSeconds] = useState<number | null>(null);

  // Gesture callbacks are created once per (width, duration) but read the live
  // preview at release, so the committed value cannot lag a render behind.
  const previewRef = useRef(0);
  const activatedRef = useRef(false);

  // -------------------------------------------------------------------------
  // Fade animation — one-shot Animated.timing with an alive ref, never a loop
  // (OrbitalSpinner.tsx's discipline: stopAnimation on unmount, guard restarts).
  // -------------------------------------------------------------------------

  const opacity = useRef(new Animated.Value(1)).current;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      opacity.stopAnimation();
    };
  }, [opacity]);

  useEffect(() => {
    if (!alive.current) return;
    try {
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: theme.duration.fast,
        useNativeDriver: true,
      }).start();
    } catch {
      // Environment torn down (e.g. Jest cleanup).
    }
  }, [visible, opacity, theme.duration.fast]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleTrackLayout = useCallback((e: LayoutChangeEvent) => {
    setTrackWidth(e.nativeEvent.layout.width);
  }, []);

  /**
   * Timestamp of the last interaction with a real control. The full-page tap
   * detector ignores toggles within CONTROL_SUPPRESSION_MS of it.
   *
   * This replaces the earlier "only mount the detector while hidden" approach.
   * That worked because there was nothing to conflict with — but tap-anywhere
   * must now DISMISS as well as show, so the detector has to stay live while
   * the chrome is up, right underneath the play button and the scrubber.
   * RNGH's native handlers do not take part in the JS responder system, so a
   * press on a control can also satisfy the full-page Tap, in
   * platform-dependent order (#518). A short suppression window is the
   * mechanism the review panel proposed for exactly this: it needs no gesture
   * relations, no ref plumbing into the touchable, and it fails safe — the
   * worst case is one ignored tap, not a dead control.
   */
  const lastControlInteractionRef = useRef(0);

  const stampControlInteraction = useCallback(() => {
    lastControlInteractionRef.current = Date.now();
  }, []);

  const handleTogglePlay = useCallback(() => {
    stampControlInteraction();
    onTogglePlay();
  }, [onTogglePlay, stampControlInteraction]);

  /** Every scrubber boundary stamps, so a drag can never toggle the chrome. */
  const handleInteraction = useCallback(
    (event: VisibilityEvent) => {
      stampControlInteraction();
      onInteraction(event);
    },
    [onInteraction, stampControlInteraction],
  );

  /**
   * Full-page tap: shows the chrome when hidden, dismisses it when visible.
   * Deliberately calls `onInteraction` raw — a toggle must not stamp itself,
   * or a quick second tap would be swallowed.
   */
  const toggleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .onEnd(() => {
          if (Date.now() - lastControlInteractionRef.current < CONTROL_SUPPRESSION_MS) {
            return;
          }
          onInteraction('tap');
        })
        .runOnJS(true),
    [onInteraction],
  );

  const panGesture = useMemo(() => {
    const gesture = Gesture.Pan()
      .activeOffsetX([-5, 5])
      .failOffsetY([-10, 10])
      .runOnJS(true)
      .onBegin((e) => {
        // Seed the committed value but do NOT render a preview yet: onBegin
        // fires on touch-down, before activation, so rendering here would snap
        // the thumb under a finger that has not dragged (and may never
        // activate). scrubStart still fires, to hold the auto-hide off.
        previewRef.current = offsetToSeconds(e.x, trackWidth, duration);
        handleInteraction('scrubStart');
      })
      .onStart((e) => {
        activatedRef.current = true;
        const seconds = offsetToSeconds(e.x, trackWidth, duration);
        previewRef.current = seconds;
        setPreviewSeconds(seconds);
      })
      .onUpdate((e) => {
        const seconds = offsetToSeconds(e.x, trackWidth, duration);
        previewRef.current = seconds;
        setPreviewSeconds(seconds);
      })
      .onFinalize((_e, success) => {
        // ONE seek per drag, on release. Seeking on every onUpdate would spam
        // the player with 60 commands/second and thrash the buffering dip that
        // ActiveVideoPage's isSeeking guard exists to absorb.
        //
        // `success` is load-bearing: RNGH calls onFinalize for END, FAILED and
        // CANCELLED alike. A pan cancelled by ScrollView arbitration must not
        // commit a seek to wherever the finger happened to be when the paging
        // gesture won.
        if (activatedRef.current && success) {
          onSeek(previewRef.current);
        }
        activatedRef.current = false;
        setPreviewSeconds(null);
        handleInteraction('scrubEnd');
      });

    // See VideoControlsProps.scrollGesture — A4 tier (iii), unwired by default.
    return scrollGesture ? gesture.blocksExternalGesture(scrollGesture) : gesture;
  }, [trackWidth, duration, onSeek, handleInteraction, scrollGesture]);

  // -------------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------------

  const displaySeconds = previewSeconds ?? currentTime;
  const fraction = fractionOfDuration(displaySeconds, duration);
  const filledWidth = trackWidth * fraction;

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  const fillStyle: ViewStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  };

  const toggleButtonStyle: ViewStyle = {
    width: TOGGLE_BUTTON_SIZE,
    height: TOGGLE_BUTTON_SIZE,
    borderRadius: TOGGLE_BUTTON_SIZE / 2,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const toggleGlyphStyle: TextStyle = {
    color: '#FFFFFF',
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    // The pause glyph pair sits visually left of centre; the play triangle
    // needs a nudge right of it to look centred in the circle.
    marginLeft: paused ? 3 : 0,
  };

  const bottomBarStyle: ViewStyle = {
    position: 'absolute',
    left: theme.spacing.base,
    right: theme.spacing.base,
    bottom: insets.bottom + theme.spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  };

  const timeTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
  };

  const trackHitStyle: ViewStyle = {
    flex: 1,
    height: TRACK_HIT_HEIGHT,
    marginHorizontal: theme.spacing.sm,
    justifyContent: 'center',
  };

  const trackStyle: ViewStyle = {
    height: TRACK_HEIGHT,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  };

  const trackFilledStyle: ViewStyle = {
    position: 'absolute',
    left: 0,
    top: 0,
    height: TRACK_HEIGHT,
    width: filledWidth,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: '#FFFFFF',
  };

  const thumbStyle: ViewStyle = {
    position: 'absolute',
    top: (TRACK_HEIGHT - THUMB_SIZE) / 2,
    left: filledWidth - THUMB_SIZE / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#FFFFFF',
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <View style={fillStyle} pointerEvents="box-none" testID="video-controls">
      {/* Always mounted — tap toggles in BOTH directions now. It sits BELOW
          the chrome in paint order, so a press still lands on the button or
          the track; the suppression window covers the case where RNGH lets
          the full-page Tap fire as well. */}
      <GestureDetector gesture={toggleTapGesture}>
        <View style={fillStyle} testID="video-controls-tap-layer" />
      </GestureDetector>

      <Animated.View
        style={[fillStyle, { opacity }]}
        pointerEvents={visible ? 'box-none' : 'none'}
        testID="video-controls-chrome"
      >
        {/* Centred play/pause */}
        <View style={[fillStyle, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="box-none">
          <TouchableOpacity
            style={toggleButtonStyle}
            onPress={handleTogglePlay}
            hitSlop={HIT_SLOP}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={paused ? 'Play video' : 'Pause video'}
            testID="video-controls-toggle-play"
          >
            <Text style={toggleGlyphStyle}>
              {paused ? PLAY_GLYPH : PAUSE_GLYPH}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Bottom bar: elapsed · track · duration */}
        <View style={bottomBarStyle}>
          <Text style={timeTextStyle} testID="video-controls-current-time">
            {formatDurationSeconds(displaySeconds)}
          </Text>

          <GestureDetector gesture={panGesture}>
            <View
              style={trackHitStyle}
              onLayout={handleTrackLayout}
              accessibilityRole="adjustable"
              accessibilityLabel="Video position"
              testID="video-controls-track"
            >
              <View style={trackStyle}>
                <View style={trackFilledStyle} />
                {trackWidth > 0 && <View style={thumbStyle} />}
              </View>
            </View>
          </GestureDetector>

          <Text style={timeTextStyle} testID="video-controls-duration">
            {formatDurationSeconds(duration)}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}
