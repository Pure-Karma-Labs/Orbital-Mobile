/**
 * scrubberLogic — pure maths + state transitions for the lightbox video overlay.
 *
 * Everything testable about the custom controls lives here. The component layer
 * (VideoControls.tsx) is deliberately dumb, because the repo's inline
 * react-native-gesture-handler jest mock swallows gestures: a component test can
 * assert wiring, never behaviour. Keeping the arithmetic and the visibility
 * state machine in a dependency-free module is what makes them actually covered.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Chrome fades out this long after playback starts (or after any interaction). */
export const AUTO_HIDE_MS = 3000;

/**
 * `progressUpdateInterval` for <Video>. 10 onProgress events/second is what
 * drives the scrubber; the re-render cost is a small, memo-free subtree. Widen
 * to 250 if profiling ever says otherwise.
 */
export const PROGRESS_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Scrubber maths
// ---------------------------------------------------------------------------

/**
 * Clamp a seconds value into the playable range.
 *
 * A non-finite or non-positive duration means "we do not know how long this is
 * yet" (onLoad has not landed), so the only safe position is 0.
 */
export function clampSeconds(seconds: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return seconds > duration ? duration : seconds;
}

/**
 * Convert a horizontal touch offset inside the scrubber track to a seek target.
 *
 * `x` is relative to the track view (RNGH reports gesture coordinates in the
 * attached view's space), and is clamped to the track — a pan that drags past
 * either edge pins to 0:00 / duration rather than seeking out of range.
 */
export function offsetToSeconds(
  x: number,
  trackWidth: number,
  duration: number,
): number {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(x)) return 0;

  const clampedX = x < 0 ? 0 : x > trackWidth ? trackWidth : x;
  return (clampedX / trackWidth) * duration;
}

/**
 * Fraction (0..1) of the track that should read as "played".
 * Zero-safe: an unknown duration renders an empty bar, never NaN width.
 */
export function fractionOfDuration(seconds: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds >= duration ? 1 : seconds / duration;
}

// ---------------------------------------------------------------------------
// Visibility state machine
// ---------------------------------------------------------------------------

/**
 * Events that can move the chrome between shown and hidden.
 *
 * - `tap`         full-page tap (only reachable while hidden — see VideoControls)
 * - `play`/`pause` transport intent from the overlay button
 * - `scrubStart`/`scrubEnd` scrubber drag boundaries
 * - `ended`       playback reached the end
 * - `timerFired`  the 3s auto-hide elapsed
 */
export type VisibilityEvent =
  | 'tap'
  | 'play'
  | 'pause'
  | 'scrubStart'
  | 'scrubEnd'
  | 'ended'
  | 'timerFired';

export interface VisibilityState {
  visible: boolean;
  /**
   * Monotonic counter bumped whenever the auto-hide countdown must restart
   * from zero. The hook keys its single setTimeout on it, so "re-arm" is
   * expressible without the reducer owning a timer.
   */
  epoch: number;
  /**
   * True for the duration of a scrubber drag. A drag longer than AUTO_HIDE_MS
   * would otherwise fade the chrome out from under the user's finger — the
   * epoch only re-arms at scrubStart, and onUpdate deliberately does not
   * dispatch (10s of reducer traffic per drag). Suppressing the countdown
   * outright is cheaper and exact.
   */
  scrubbing: boolean;
}

export const INITIAL_VISIBILITY: VisibilityState = {
  visible: true,
  epoch: 0,
  scrubbing: false,
};

/**
 * Reducer for chrome visibility.
 *
 * Two contracts matter (both are #518 lessons, restated by plan-review B3):
 *
 *  1. `play` and `pause` ALWAYS resolve to visible-plus-rearmed — pressing the
 *     button can never hide the button you just pressed, whatever order the
 *     tap layer and the touchable resolve in. This is the reducer half of the
 *     defence; VideoControls' suppression window is the other half.
 *  2. `tap` TOGGLES in both directions (tap-anywhere-to-dismiss, Alex
 *     2026-07-30). Distinguishing a tap on empty space from a press on a
 *     control is VideoControls' job, not the reducer's — by the time an event
 *     reaches here it has already been judged.
 *
 * Returns the SAME object when nothing changes, so useReducer bails out of the
 * re-render.
 */
export function nextVisibility(
  state: VisibilityState,
  event: VisibilityEvent,
): VisibilityState {
  switch (event) {
    case 'tap':
      // Showing arms the countdown; dismissing has nothing to count down, so
      // the epoch stays put (same reasoning as timerFired).
      return state.visible
        ? { visible: false, epoch: state.epoch, scrubbing: state.scrubbing }
        : { visible: true, epoch: state.epoch + 1, scrubbing: state.scrubbing };

    case 'play':
    case 'pause':
    case 'ended':
      // Always show and restart the countdown. `pause`/`ended` also disarm it
      // via shouldArmAutoHide (not playing), so the chrome stays up.
      return {
        visible: true,
        epoch: state.epoch + 1,
        scrubbing: state.scrubbing,
      };

    case 'scrubStart':
      return { visible: true, epoch: state.epoch + 1, scrubbing: true };

    case 'scrubEnd':
      // Re-arm from release, not from the start of a long drag.
      return { visible: true, epoch: state.epoch + 1, scrubbing: false };

    case 'timerFired':
      return state.visible
        ? { visible: false, epoch: state.epoch, scrubbing: state.scrubbing }
        : state;

    default:
      return state;
  }
}

/**
 * Timer-arming predicate: the countdown runs only while the chrome is up AND
 * the video is actually playing. Paused, ended, or already-hidden states leave
 * no timer pending — that is what keeps a paused player's controls on screen.
 *
 * Callers pass `playing && !scrubbing`: a drag in progress must hold the
 * chrome open however long it lasts.
 */
export function shouldArmAutoHide(visible: boolean, playing: boolean): boolean {
  return visible && playing;
}
