/**
 * useControlsVisibility — auto-hiding chrome state for the lightbox video overlay.
 *
 * Wraps the pure reducer in scrubberLogic with exactly ONE setTimeout, armed
 * only while `shouldArmAutoHide(visible, playing)` holds and cleared on every
 * re-arm and on unmount. No interval, no Animated.loop, no timer stored in a
 * ref that can outlive the component.
 */

import { useCallback, useEffect, useReducer } from 'react';
import {
  AUTO_HIDE_MS,
  INITIAL_VISIBILITY,
  nextVisibility,
  shouldArmAutoHide,
  type VisibilityEvent,
} from './scrubberLogic';

export interface UseControlsVisibilityResult {
  /** Whether the chrome (play/pause + bottom bar) is on screen. */
  visible: boolean;
  /** Feed a transition into the state machine. Stable identity. */
  notify: (event: VisibilityEvent) => void;
}

/**
 * @param playing true while the player is actually running — the only state in
 *   which the chrome is allowed to disappear on its own.
 */
export function useControlsVisibility(playing: boolean): UseControlsVisibilityResult {
  const [state, dispatch] = useReducer(nextVisibility, INITIAL_VISIBILITY);

  const notify = useCallback((event: VisibilityEvent) => {
    dispatch(event);
  }, []);

  useEffect(() => {
    // `!state.scrubbing`: a drag longer than AUTO_HIDE_MS must not fade the
    // chrome out from under the finger holding it.
    if (!shouldArmAutoHide(state.visible, playing && !state.scrubbing)) {
      return;
    }
    const id = setTimeout(() => dispatch('timerFired'), AUTO_HIDE_MS);
    return () => clearTimeout(id);
    // `epoch` is the re-arm signal: an interaction bumps it without changing
    // `visible`, which must still restart the countdown from zero.
  }, [state.visible, state.epoch, state.scrubbing, playing]);

  return { visible: state.visible, notify };
}
