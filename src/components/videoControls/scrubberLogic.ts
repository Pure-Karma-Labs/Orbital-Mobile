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
}

export const INITIAL_VISIBILITY: VisibilityState = { visible: true, epoch: 0 };

/**
 * Reducer for chrome visibility.
 *
 * Two contracts matter (both are #518 lessons, restated by plan-review B3):
 *
 *  1. `play` and `pause` ALWAYS resolve to visible-plus-rearmed — pressing the
 *     button can never hide the button you just pressed, whatever order the
 *     tap layer and the touchable resolve in.
 *  2. `tap` only ever transitions hidden -> visible. There is no tap-to-hide,
 *     because the full-page tap detector is unmounted while the chrome is
 *     visible; dismissal is the timer's job alone.
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
      // Hidden -> visible only. A tap while visible is a no-op by design.
      return state.visible ? state : { visible: true, epoch: state.epoch + 1 };

    case 'play':
    case 'pause':
    case 'scrubStart':
    case 'scrubEnd':
    case 'ended':
      // Always show and restart the countdown. `pause`/`ended` also disarm it
      // via shouldArmAutoHide (not playing), so the chrome stays up.
      return { visible: true, epoch: state.epoch + 1 };

    case 'timerFired':
      return state.visible ? { visible: false, epoch: state.epoch } : state;

    default:
      return state;
  }
}

/**
 * Timer-arming predicate: the countdown runs only while the chrome is up AND
 * the video is actually playing. Paused, ended, or already-hidden states leave
 * no timer pending — that is what keeps a paused player's controls on screen.
 */
export function shouldArmAutoHide(visible: boolean, playing: boolean): boolean {
  return visible && playing;
}
